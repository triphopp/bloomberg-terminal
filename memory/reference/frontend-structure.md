# Frontend Structure Reference

**Last updated:** 2026-06-06

> **See also:** [data-shapes.md](data-shapes.md) — TypeScript interfaces + API response shapes | [api-endpoints.md](api-endpoints.md) — all backend endpoints | [architecture.md](architecture.md) — backend file structure | [gotchas.md](gotchas.md) — "Where is X?" lookup + anti-patterns

---

## Portfolio accounting exports (2026-09-25)

All paths below are relative to `components/bloomberg/views/portfolio/`.

| File | Exports / consumer |
|---|---|
| `accounting-types.ts` | `AccountingFinding`, `AccountingReport`, `StockCard` interfaces; [shapes](data-shapes.md#accounting-previews-2026-09-25) |
| `modals/StockCardModal.tsx` | `StockCardModal`: account/symbol card, AVCO/FIFO preview, running quantities/costs, allocation detail; native dialog with Escape |
| `ui/LedgerPanel.tsx` | `LedgerPanel` (PORT → TOOLS → AUDIT → LEDGER): mode LEGACY/SHADOW, wallet balances vs broker statement, forms MOVE (wallet → wallet, FX if currencies differ) · FX CONVERT · CLOSE PERIOD · OPENING · ADJUST · WALLET, checks L1–L9, events + reverse |
| `ui/NumInput.tsx` | `NumInput` — drop-in for `<input type="number">` with thousands separators while typing; `e.target.value` stays the plain number; keeps half-typed `12.`; caret kept after the same digit; `allowNegative` opt-in. Pure helpers in `lib/number-input.ts` (`sanitizeNumber`, `groupNumber`, `sameNumber`, caret math; test in `lib/__tests__/number-input.test.ts`) |
| `ui/ledger-client.tsx` | Ledger v2 shared UI: `useLedgerAccounts`, `useInvalidateLedger`, `ledgerCall`, `localDay`, `WalletSelect` (ENTRY + SellModal: auto → slip/rule/default), `WalletMoveForm` (transfer, or FX when currencies differ — needs the arrived amount), `LedgerWalletStrip` (CASH tab: wallets, agreed ●, ≈฿, MOVE / FX). SummaryBar shows `LEDGER(…) ฿x ●` next to derived CASH |
| `lib/ledger-correction.ts` | `installLedgerCorrectionRetry` (PortfolioView mount): 409 `LEDGER_PERIOD_CLOSED` on a PORT write → prompt reason → retry with `X-Ledger-Correction`; `needsCorrection` |
| `ui/AccountingChecksPanel.tsx` | `AccountingChecksPanel`: React Query findings, severity filters, evidence, explicit read-switch gates, incomplete coverage labels, card drill-down |
| `ui/AccountingPreparePanel.tsx` | `AccountingPreparePanel`: dividend XD/sub-account and opening preview; records cited broker statement revision only after arithmetic preview; shows dated cash/quantity differences; edits invalidate stale responses |
| `tabs/AuditTab.tsx` | ACCOUNTING CHECK / PREPARE RECORDS / CHANGE LOG under PORT → TOOLS → AUDIT; BROKER FILLS filter shows cited Dime execution rows and expandable image/hash fields |
| `tabs/OpenPositionsTab.tsx` | CARD button opens the stock card of that row's sub-port (`sub_port`). An account with ≥2 sub-ports renders one section per sub-port under its group header (MV · % · cost · TAKEOVER DEBT · unreal, collapsible `${group}::${sub}`); toolbar chips ALL/sub-ports filter (`localStorage["bloomberg_portfolio_subport"]`). Rows merge per account+symbol+sub-port |
| `sub-ports.ts` | `splitNote`, `subPortOf`, `subPortSections`, `subPortsIn` — pure, tested (`__tests__/sub-ports.test.ts`); same rule as `backend/sub_port.py` |
| `takeover-hint.ts` | `transferCostHint(lots, px, qty)`, `TRANSFER_PX` — hover text (`title`) + dotted underline on the entry price of a lot received in kind (`acquisition_type = 'TRANSFER_IN'`): previous owner's cost and the transfer price/date; null for every other lot. Used by POSITIONS (row + expanded lot) and TRADES. Pure, tested (`__tests__/takeover-hint.test.ts`), 2026-10-07 |

Preview POSTs do not write data. Choosing FIFO here does not change the live sell method. Next proxies: `app/api/v2/portfolio/ledger/{check,stock-card,prepare-dividend,check-opening}/route.ts`.

## Component Tree

```
components/bloomberg/
├── layout/
│   ├── bloomberg-terminal.tsx   ← root view router (6 views: MKT · NEWS · BOND · PORT · TAIL · HMAP)
│   ├── tail-risk-ribbon.tsx     ← fixed TAIL level + top 3 named events in shared 24px status row
│   ├── alert-ticker.tsx        ← fixed alert summary beside continuously scrolling market quotes
│   ├── terminal-header.tsx      ← top nav bar + view buttons (phone <768px: title + ask + search)
├── ask/                         ← ASK, the one chat with the model (2026-10-06): store.ts (atoms) · useAskConversation.ts (request/stream) · ask-panel.tsx (AskDock / AskBar / AskColumn / useAskContext) · ask-answer.tsx · ask-settings.tsx · index.ts (public API). Views import from `ask`, never copy
│   ├── mobile-nav.tsx           ← phone bottom view switcher (replaces header nav; ribbon + ticker hidden)
│   ├── terminal-layout.tsx      ← keyboard shortcut binding wrapper
│   └── terminal-filter-bar.tsx  ← watchlist filter
│
├── views/
│   ├── market-view.tsx          ← MKT: watchlist + chart + global indices + Regime panel
│   ├── iv-smile-panel.tsx       ← REGIME IV: selected chart symbol, optional Raw SVI, single/multiple monthly expiries, K vs IV%
│   ├── depth-panel.tsx          ← STRUCTURE DEPTH: bid/offer ladder of the chart symbol (Webull, US only) + every not-ready state as a sentence
│   ├── news-view.tsx            ← barrel → views/news/index.tsx (kept for the dynamic import path)
│   ├── news/                    ← NEWS view (2026-08-15 redesign)
│   │   ├── index.tsx            ← shell: WATCHLIST | NEWSFEED | SOCIAL tabs + shared Polymarket column
│   │   ├── watchlist-tab.tsx    ← sector rail + article stream + per-symbol HEADLINES/RATE STRESS/DCF/REGIME panels
│   │   │                          (group: SECTOR/TICKER/TIME · match: NAMED/ALL NEWS · sentiment · source toggles)
│   │   ├── newsfeed-tab.tsx     ← topic newswire (was the FEED tab)
│   │   ├── social-tab.tsx       ← X/YouTube/Reddit/RSS handles
│   │   ├── (ASK moved to components/bloomberg/ask — NewsView mounts `<AskBar />` + `<AskColumn />`, which takes the Polymarket column's place while shown)
│   │   ├── polymarket-column.tsx← {SYM} IMPLIED ladder + WATCHLIST MARKETS + MACRO SIGNALS + search
│   │   ├── prediction-ladder.tsx← implied distribution panel (CLOSE ABOVE CDF + TOUCH LADDER)
│   │   ├── useWatchlistNews.ts  ← useWatchlistSymbols() (pins atom → localStorage fallback) + React Query (partial answer, then settle polls)
│   │   ├── useNewsQueries.ts    ← React Query for NEWSFEED / SOCIAL (one query per handle) / Polymarket signals+search; REFRESH → `fresh=1`; follow-up when the backend says `refreshing`
│   │   ├── constants.ts / helpers.ts / types.ts
│   ├── heatmap-view.tsx         ← HMAP: `heatmap(MARKET)` sector treemap (replaced GMOV 2026-09-25)
│   ├── calendar/                ← CAL [6] (2026-10-08): index.tsx `CalendarView` (month grid 6 weeks Monday-first /
│   │                              agenda, category · kind · thesis filters, source notices), DayPanel.tsx (one day:
│   │                              source, ≈ estimated, links to thesis / question, + ผูกกับ thesis), AddEventForm.tsx
│   │                              (→ thesis note or question-calendar date), month.ts (pure grid + filter),
│   │                              types.ts, __tests__/ — `GET /api/calendar`
│   ├── tail-risk-view.tsx       ← TAIL: 6 dimensions + macro context (EventStrip under HealthStrip, MacroPanel in left column, EVENT tag on VIX signals, event ReferenceLines on 90D chart)
│   ├── tail/macro-context.tsx   ← useMacroContext() + EventStrip + MacroPanel + KIND_COLOR (2026-09-17)
│   ├── tail/decomposition.tsx   ← RealRatesPanel + EnergySpreadsPanel (EVIDENCE section, 2026-09-24)
│   ├── tail/market-events.tsx   ← MarketEventsPanel — named events + evidence + earlier sessions (2026-09-24)
│   ├── tail/sector-rotation.tsx ← SectorRotationPanel + useSectorRotation() — diverging bars + tilt (2026-09-23)
│   ├── tail/positioning.tsx     ← PositioningPanel — CFTC crowding flags + table (POSITIONING section, 2026-09-25)
│   ├── tail/cycle.tsx           ← CyclePanel + useCycle() — official cycle indicators, rule + track record per row (BUSINESS CYCLE section, 2026-10-07)
│   ├── bonds/                   ← BOND [B] (2026-09-25): price (Treasury leg / credit leg) vs supply (SEC deals, Treasury auctions, Z.1)
│   │   ├── index.tsx            ← BondView — 4 queries /api/bonds/{overview,decomposition,supply,issuance}; polls 8s while EDGAR backfill runs
│   │   ├── charts.tsx           ← HistoryChart, IssuanceChart, TreasurySupplyChart, SlowCard, RANGES
│   │   ├── tables.tsx           ← KpiStrip, EventStudyPanel, DealsPanel, AuctionsTable
│   │   ├── conditions.tsx       ← ConditionsTab (ex-CRDT): crisis LevelPanel + FSI/NFCI, breakevens, household credit charts
│   │   ├── ui.tsx / types.ts    ← C palette (up = red: rising yield/spread = tightening), Panel, fmtBp; API types
│   ├── stock-view.tsx           ← Equity analysis tabs incl. DCF/RATE STRESS/REGIME — no nav button, via search/heatmap
│   ├── stock/dcf/index.tsx      ← shared adaptive DCF lab: model/scenario controls + 5 quant sub-tabs
│   ├── stock/dcf/types.ts       ← DcfModel/DcfScenario and API response contracts
│   ├── pinned-assets.tsx        ← Pinned assets sidebar
│   ├── options-tab.tsx          ← stock-view OPTIONS tab: chain, strategies (10 auto-scan), builder, greeks, vol surface
│   ├── strategy-builder.tsx    ← Strategy Builder: 19 templates, multi-expiry (Calendar/Diagonal), BS payoff, leg editor
│   ├── ui-primitives.tsx        ← shared UI primitives (created, not yet migrated to all views)
│   │
│   └── portfolio/               ← PORT: barrel re-export from portfolio-view.tsx
│       ├── index.tsx            ← PortfolioView shell: account tabs, summary bar, 4 top-level tabs (Alt+1-4) + context-sensitive sub-tab bar
│       ├── types.ts             ← all interfaces; Trade/Dividend expose native currency + additive `*_base` report-currency fields
│       ├── helpers.ts           ← fmt, fmtAmt (exact, 2dp), fmtPx (trade price 2–4dp), fmtQty (volume ≤7dp), fmtAxis (K/M, chart ticks only), fmtPct, pnlColor, wlColor, groupKey, FLAG
│       ├── constants.ts         ← ALL_COLS, DEFAULT_COLS, DENSE_COLS, TH_SECTORS (34), US_SECTORS (11),
│       │                           GROUP_COLORS, FINANSIA_SUBS, ALLOC_COLORS, SECTOR_COLORS
│       ├── ui/
│       │   ├── AccBadge.tsx     ← AccBadge, WLBadge
│       │   └── SummaryBar.tsx   ← top summary; broker-style total P&L plus secondary ECON FX-inclusive attribution
│       ├── modals/
│       │   ├── SellModal.tsx    ← sell / partial-sell modal
│       │   └── TradeEditModal.tsx ← trade edit modal (17 fields, bulk-patch-sector). Open trades show **S/L · TARGET** (with % from entry; blank = clear → PATCH sends null). From a merged POSITIONS row, `siblingLotIds` makes the level change go to every lot (the row shows lot 0's levels)
│       └── tabs/
│           ├── OpenPositionsTab.tsx  ← positions table: DENSE, COLS picker, SELL/EDIT, grouped lots, instrument-currency badge + backend-normalized report totals
│           ├── OptionsTab.tsx        ← options positions + live Greeks (Black-Scholes + Gram-Charlier)
│           ├── TradeLogTab.tsx       ← trade history with filter + WLBadge; dated `amount_base`/`pnl_base` display
│           ├── CashTab.tsx           ← cash flow CRUD + currency-aware dividends CRUD + Finansia subs
│           ├── AnalyticsTab.tsx      ← report-currency P&L/allocation/dividend charts (M/Q/Y); broker-style P&L plus ECON FX attribution tooltips
│           ├── RiskTab.tsx           ← 6 pages (2026-10-07, was 8 — one look on the first page): สรุป (RiskSummaryCard → BearPathStrip → MarginCard → TradeGuardCard → DecisionJournalPanel, then the methods that used to be the เชิงลึก tab: header stats → VaR table + VarValidationCard | risk-contrib/ERC + correlation → EWS · accounts · COT) · REBALANCE (RebalancePanel; badge = TRIM count; "ยังไม่ขาย" = HOLD with a reason) · BUDGET · FACTOR (RiskBudgetPanel then FactorExposurePanel; red badge = buckets over budget + the volatility cap) · WHAT-IF (WhatIfSimPanel, mounted on first visit then kept hidden so ticks survive) · MONTE CARLO · ขาลง (BearPathPanel then MonteCarloPanel — the book as held, follows the account selector) · OPTIONS. Opens on the page in `riskSubTabRequestAtom` when another component set it (alert link → REBALANCE). Backtest/Kupiec only in VarValidationCard; ERC trades only as WHAT-IF suggestions
│           ├── ThesesTab.tsx         ← barrel → tabs/theses/
│           │   ├── theses/graphs/     ← RESEARCH sub-tab (ex-GRAPHS; code still `graphs`): GraphsPanel — lists rendered analysis
│           │   │                        pages for the thesis, previews one in a sandboxed
│           │   │                        iframe (no allow-same-origin: the HTML is agent-written)
│           │   └── theses/zettel/     ← KB sub-tab: ZettelPanel (list+detail+create),
│           │       theses/anti/       ← ANTI-THESIS sub-tab (2026-10-08): AntiPanel — step back: claims beside their
│           │                            negation, objections per angle, evidence-gated verdicts (`/api/v2/antithesis`)
│           │                             ConflictPanel (two sides + RESOLVE),
│           │                             ZettelGraph (deterministic radial SVG)
│           ├── questions/             ← TOOLS → QUESTIONS: index.tsx (thesis strip, tree with convergence
│           │                             stubs, detail: thought / answer / assumptions / signals / effect on
│           │                             parents / evidence, ACCEPT · REJECT · DROP, add form) + types.ts
│           │                             + CalendarView.tsx (dates; lists the tracked numbers read on each)
│           ├── tracking/              ← TOOLS → TRACK: index.tsx (thesis strip incl. "all", board sorted by
│           │                             urgency, detail: where to read / kill line / next forecast / forecast-vs-
│           │                             actual table, retire) + forms.tsx (metric, forecast, reading) + types.ts
│           ├── theses/                ← DB-backed thesis system (CRUD + notes + history)
│           │   ├── index.tsx          ← rail + detail + sub-tabs THESIS|NOTES|HISTORY|LINKED TRADES|AI
│           │   ├── ThesisNavigator.tsx ← the ONE thesis list of TOOLS (THESES · QUESTIONS · TRACK): search ("/"), kind chips,
│           │   │                         sector / status selects, owed-work + unread toggles, group + sort, one line per thesis
│           │   │                         with question / track / unread badges; `NavRail` = foldable column. Filter state
│           │   │                         `localStorage["bloomberg_thesis_nav"]`; selection = `toolsThesisIdAtom` (shared)
│           │   ├── nav-filter.ts      ← pure filter / group / sort / kindOf / sectorOf (test: __tests__/thesis-nav-filter.test.ts)
│           │   ├── useReads.tsx       ← read marks: `useReads()`, `ReadDot`, `UnreadBar` (/api/v2/reads)
│           │   ├── QuickTopic.tsx     ← "+ หัวข้อใหม่": an empty draft thesis (short name + kind) from QUESTIONS / TRACK
│           │   ├── ThesisEditor.tsx   ← form + markdown editor/preview
│           │   ├── ThesisNotes.tsx    ← standing scenarios/risks/catalysts: kind filter, L×S score, watch date, resolve
│           │   ├── ThesisTimeline.tsx ← thesis_events feed + manual notes
│           │   ├── markdown.tsx       ← renderMarkdown
│           │   └── types.ts
│           └── ImportTab.tsx         ← Excel drag-drop + manual form. **ENTRY shows six fields only** (ACCOUNT · SYMBOL · DATE ENTRY · PRICE ENTRY · VOLUME · STRATEGY) plus the REINVEST checkbox (IS OPTION removed 2026-09-26 — it wrote `PUT_INTC`-style `trades` rows); SECTOR · STOP LOSS · TARGET · ENTRY TRIGGER · VAT · SUB-PORT · NOTE sit behind the ADD FIELD row (`ui/useEntryExtras.tsx`). Grids size themselves from how many optional cells are on, so a hidden field leaves no gap. `autoFillSector()` reads `/api/stock/sector/{resolved}` and takes the first of `[set_sector, us_sector]` that the account's list offers; anything undecidable reveals the SECTOR picker instead of guessing
│               ENTRY = the one place fills are typed (2026-09-26): switch `หุ้น / ETF / CRYPTO | ออปชัน`; a stock SELL of a held symbol offers `SellModal` (same /sell as POSITIONS); prop `optionPrefill` (from OPTIONS → ADD/CLOSE via `index.tsx` `openOptionEntry`)
│               ui/OptionEntryForm.tsx ← option fill form → `POST /api/options/fills`: side × open/close, contract, contracts, premium, US trade date, fill time (Bangkok), settle date, order no., close reason (ขาย/หมดอายุ/ใช้สิทธิ์/assign), lots FIFO or picked, fee lines (COMMISSION, discount, VAT, OCC, ORF, TAF); dry_run preview of cash + realized before SAVE. Exports `OptionEntryPrefill`
│               ui/SlipReader.tsx     ← (2026-09-26: up to 4 screenshots per order — after a non-ok read the next image joins the same order; `isOptionSlip()`; option slips route to OptionEntryForm)
│               ui/SlipReader.tsx     ← (2026-10-01: `onPages` → ENTRY shows the screenshots large in a sticky right column while loaded; `resetSeq` bumped by ENTRY SAVE/CLEAR clears pages/result; only a `fail` read or an unfinished OPTION `review` takes the next image as the same order — stock slips always start a new one; Ctrl+V works with the caret in a field) `<SlipReader onFill>`: compact "SLIP · ลากวาง / คลิกเลือก" button beside ENTRY intro; Ctrl+V / drop anywhere while ENTRY is mounted / click a broker slip screenshot → `POST /api/v2/portfolio/slip/read` → `ImportTab.fillFromSlip()` sets side, account (hint), symbol (+ resolve), date/price/volume/fee, note with the order ref, reveals FEES + NOTE; shows checks, warnings, duplicate-order alert. Never saves
│               ui/EntryValueCheck.tsx ← (2026-09-28) slip-order check card above SAVE TRADE: BUY/SELL total (value ± fees), PRICE · QUANTITY, SHARE VALUE = px × qty, COMMISSION / VAT / SEC / TAF — from the slip (while its fee is untouched), else "typed", else the broker estimate
│               ui/useEntryExtras.tsx ← `useEntryExtras()` (state in `localStorage["bloomberg_entry_extra_fields"]`, `showExtra` reveals but never hides) + `<ExtraFieldToggles>`, the text-only `+ FIELD` / `− FIELD` row
│
├── chart/
│   ├── ModularChart.tsx         ← reusable chart container (candle + overlay/pane indicators + event rail). **Grid in the price pane only** — the library's chart-wide grid is `visible: false`; the price pane draws its own via `createPriceGridOverlay()` (`price-grid-overlay.ts`), an `OverlayPrimitive` at `zOrder: "bottom"`, always first in `allOverlays`. Indicator sub-panes have no grid because nothing draws one there. No `createSeriesMarkers` — events are drawn by the rail overlay. `onBarClick(time, ctx)` reports markers only when the drawn icon/cluster is clicked (including future whitespace) + viewport coords
│   ├── price-grid-overlay.ts   ← the chart grid as our own bottom layer in the price pane: horizontal lines on round prices (`niceStep()` / `priceLevels()`, ~10 rows), vertical lines on calendar boundaries in the data — `chooseBoundaries()` picks the finest of month/week/day/hour that fits the pane width (weeks are Monday-aligned), then thinned to ≥30px apart, so a 3M chart and a 5Y chart end up equally dense. Drawn as LaTeX/TikZ-style dot rules (round cap + zero-length dash, 4px pitch) so the grid reads as background against the indicator lines over it. Pure helpers tested in `__tests__/price-grid-overlay.test.ts`
│   ├── event-icons.ts          ← Path2D icon set for the rail (`cash` · `arrowUp` · `arrowDown` · `clock` · `split`) + `drawEventIcon()`. Lucide 24×24 grid so `EventDetailPopover` can render the matching `lucide-react` component and the canvas/DOM marks stay the same vocabulary
│   ├── event-rail-overlay.ts    ← CanvasOverlay drawing icon chips on a fixed 18px row at the bottom of the price pane — **no background band or divider** (removed 2026-08-31; each chip paints its own ~87% pane-colour backdrop so wicks pass behind it and the row is invisible where nothing sits on it): banknote = dividend, trending up/down = beat/miss, clock = no surprise reported, split, `···N` cluster (still text — a count is the one thing an icon cannot say). Dashed border = `upcoming`, queued right of the last bar. `clusterChips()` + `eventChipStyle()` are pure and tested
│   ├── EventDetailPopover.tsx   ← detail card for clicked events: EST vs ACTUAL EPS + BEAT/MISS, dividend amount + yield, split ratio, gap/close/D+1/D+5 reaction. An `upcoming` event shows EX-DATE/PAY DATE and "Scheduled — no price reaction yet" in place of the reaction block. Opens on a list when a cluster is clicked. Closes on Escape or an outside click
│   ├── event-reaction.ts        ← pure helpers: `earningsSession()` (BMO/AMC off `reportedAt`), `findEventBarIndex()` / `placeEvents()` (single placement rule shared by the rail and the card; future-dated events are kept with `future: true` + `daysAhead`, capped at `MAX_FUTURE_DAYS` 200), `daysPastLastBar()`, `computeEventReaction()`. Tested in `__tests__/event-reaction.test.ts`
│   ├── bb-volume-overlay.ts     ← CanvasOverlay (`mode: "full"`, `zOrder: "bottom"`) drawing volume INSIDE the Bollinger Band of the first BB whose `volOverlay` ≠ `off` (wired in `useChartIndicators`, candle charts only). Columns stand on the lower band, height = fraction of band width (min 12px space so a squeeze does not erase them); dashed line = VOLUME σ threshold (not price σ). Ordinary bars neutral grey (green/red read as more candles). `profile` mode = per-calendar-block VP (HVN ≥ mean+σ·sd of buckets, POC, VA, naked POC dashed right). BB params `volOverlay volSigma volLookback volShow volOpacity vpPeriod vpBars` = `BB_VOLUME_PARAMS`; alert builders skip them via `BB_VOLUME_PARAM_KEYS`. Readings in `lib/bb-volume.ts`
│   ├── volume-event-overlay.ts  ← CanvasOverlay (`mode: "full"`, `zOrder: "top"`) drawing a 2-char chip per classified volume event (`CX AB VC BO ND DU`) **anchored to the bar**, above the high when the up side owned it and below the low when the down side did — the opposite choice from the corporate-event rail, because direction is half of what a volume event says, and it also keeps the two rows from stacking. One hue per TYPE, never per direction. Classifies inside `draw` (the only place the bar array exists) and caches on that array's identity, so it runs once per data change and not once per frame. Collisions are resolved strongest-|z|-first and the loser is DROPPED, not clustered — a `···N` would hide the one thing a chip exists to name, and the panel lists every event anyway. `resolveCollisions()` is pure and tested in `__tests__/volume-event-overlay.test.ts`
│   ├── VolumeEventPanel.tsx     ← the event list under the chart: DATE · EVENT (code + ▲/▼ + `×N` run length) · Z · RET · +1 · +5. The forward-return columns are the point rather than decoration — a label is only worth reading if its outcomes separate from the symbol's unconditional behaviour. Classifies the same bars the overlay does with the same defaults, so the two agree with nothing passed between them
│   ├── bollinger-fit.ts         ← pure 209-pair grid search (n=10..100 step 5, k=1..3.5 step .25); long/cash breakout %B > 1 enter / <= .5 exit at next open, net per-bar Sharpe, common warmup + train/holdout. WeakMap cache per immutable OHLCV array and cost.
│   ├── BollingerFitSummary.tsx  ← picker diagnostics: selected n/k, train/holdout Sharpe, net returns, trades, date ranges, assumptions and explicit unavailable/manual fallback.
│   ├── ChartTimeframeBar.tsx    ← period selector (1D/1W/1M/3M/YTD/1Y/5Y/MAX)
│   ├── TimeframeRow.tsx         ← Shared period + interval control. `TimeframeControls` = bare periods + interval picker (no row) — MKT seats it in the chart **footer** under the date axis, left of O/H/L/C (2026-09-28). `TimeframeRow` (row + `middle`/`trailing` slots, stacks <950px) is used by chart windows (`ChartPanel`). MKT layout: row 1 = compact SYMBOL search + quote header · row 2 = tools (indicator/compare/VP/VEVT/REG/draw/P·E ← → POP/AREA/CANDLE) · chart · footer = timeframe + stats. `useAnchoredPanel` flips its panel upward when the trigger is in the lower half of the viewport.
│   ├── useAnchoredPanel.ts      ← open state + fixed-viewport coords for a dropdown that must escape a clipping toolbar. Listeners bind to the trigger's OWN document/window, so the panel also closes correctly inside a detached chart window
│   ├── ChartPanel.tsx           ← the MKT chart panel packaged for reuse: quote header · indicator bar (IndicatorPicker + VP/VEVT/REG/P·E/FP — **no EVT button**: the event rail is always on for an equity candle chart, see `useChartIndicators`) · `TimeframeRow` · ModularChart (+ F&G / P/E sub-panes, EventDetailPopover) · OHLC footer. Owns its queries; `paused` skips the history fetch and body (minimized window) while keeping the quote. market-view still renders its own inline copy of the whole panel — it is entangled with the symbol search and layout splitters — but both share the timeframe control (`TimeframeControls` / `TimeframeRow`)
│   ├── DetachedChartWindow.tsx  ← chart in a REAL `window.open` window, portalled into the child document so it stays one React tree (same atoms, same React Query cache). Parent stylesheets are cloned into the child head. **Window name is unique per detach** — Chrome remembers a named popup's geometry (including maximized, which script cannot resize) and would pin the chart there forever. Saved bounds are re-applied at 0/60/300/800/1500ms because a freshly opened popup ignores `resizeTo` until it settles. Screen bounds sampled every 2s → `chartWindowNativeBoundsAtom`. Closing the native window closes the entry; closing the terminal tab closes the window
│   ├── ChartWindowLayer.tsx     ← renders every chart window — docked in-page, detached as real windows; docks everything on mount (a native window cannot be reopened without a user gesture); portalled to <body>, `fixed inset-0 pointer-events-none z-[60]`, mounted once in `layout/bloomberg-terminal.tsx` so windows survive view switches. Carries the CHARTS n/10 + CLOSE ALL manager strip (bottom-left, above the alert ticker)
│   ├── FloatingChartWindow.tsx  ← one draggable/resizable in-page chart popup: `<ChartPanel>` plus window controls (detach ⧉ / minimize / close) in the panel's header row, which doubles as the drag handle, and a resize grip. Per-window state = symbol + timePeriod + barInterval + geometry ONLY — indicators still come from the global spec atoms, so every chart (incl. the MKT panel) shares one indicator set. Minimized ⇒ history query disabled + chart unmounted; the quote stays so the collapsed bar keeps its price. **Clamping is display-only** — the stored x/y/w/h is the user's intent and is never rewritten to fit the viewport; an earlier version committed the clamped value on mount and on every browser resize, which permanently "reset" any window near an edge whenever the browser was resized or moved to another monitor. **Resize freeze**: ModularChart rebuilds its whole lightweight-charts instance whenever its measured height changes, so while `isResizing` the chart body is pinned at the height it had at gesture start and re-measures once, on release — without it a resize drag tore the chart down ~18 times
│   ├── useWindowDrag.ts         ← pointer-driven drag + resize. Listeners on `window` (not the element) so the gesture survives the cursor outrunning the box; geometry is local state during the gesture and committed via `onCommit` once on pointerup, so a drag is ONE localStorage write, not one per mousemove. `[data-no-drag]` on a title-bar child keeps it clickable. Re-clamps on mount + window resize
│   ├── window-geometry.ts       ← dependency-free rules behind the windows: `clampWindow` (title bar can never leave the viewport — body may hang off bottom/right), `cascadeOrigin` (+28px diagonal, wraps every 8, bounded by the ACTUAL window size not the default), `resolveOpenGeometry` (remembered layout → last-used size + cascade → defaults), `rememberLayout` (recency-ordered, capped at `MAX_REMEMBERED_LAYOUTS`), `hasGeometry`, `nextZ`, `canOpenWindow` (cap 10, but re-opening an existing symbol always allowed — it focuses instead of duplicating). Tested in `__tests__/window-geometry.test.ts`
│   ├── IndicatorPicker.tsx      ← technical indicator selector (number params + `type:"select"` dropdown params); `compact` keeps active chips on a scrollable line, and the menu portals to the trigger's document so clipped MKT toolbars and detached chart windows remain usable. **⚙ บนทุก chip ที่มี param** (2026-10-01) → เปิด editor ของ instance นั้น (โหมด EDIT, ค่าจริงที่ตั้งไว้) → APPLY เรียก `onReplace` = แก้ตัวเดิมในที่ ไม่ซ้อนตัวใหม่
│   ├── RegressionControls.tsx   ← REG + เพิ่ม channel; R1/R2… เลือกชุดที่ปรับ mode; × ลบทีละชุด ใช้ร่วมกันใน MKT และ ChartPanel
│   ├── TrendLineControls.tsx    ← ปุ่ม icon เส้น: คลิก 2 จุดบน price pane = trend line (Shift ตอนจุดที่ 2 = แนวนอน); แต่ละเส้นเป็น object: คลิกเส้น = เลือก (หนาขึ้น + handle กลวง + กล่อง × สีแดงกลางเส้น) → คลิก × หรือกด Delete/Backspace ลบเฉพาะเส้นนั้น, Esc/คลิกที่ว่าง = ยกเลิกเลือก (hit-test ผ่าน `TrendHitMap` ที่ overlay เขียนตอน draw + `ChartClickContext.panePoint`, tolerance 8px). ปุ่ม toolbar เหลือ icon + จำนวนเส้น (ไม่มี ↶/× แล้ว, 2026-09-28) — MKT, ChartPanel, stock-view; overlay `indicators/trend-line.ts`, เก็บใน backend `chart_drawings` ผ่าน `useChartDrawings` (scoped symbol+interval, sync ข้ามเครื่อง)
│   ├── FearGreedPane.tsx        ← recharts sub-pane (F&G 0–100 + zone bands)
│   ├── PEPane.tsx               ← recharts sub-pane: trailing P/E line + p10/p90 valuation bands + percentile label (consumes /api/stock/pe-history)
│   ├── useChartIndicators.ts    ← indicator/overlay state; `replaceIndicator(oldId, entry, params)` = แก้ instance เดิมในที่ (ใช้โดย ⚙); exposes vpConfig, showPE via atoms, plus `selectedEvent`/`clearSelectedEvent` for the detail card. REG หลายชุด + trend lines อ่าน/เขียนผ่าน `useChartDrawings` (backend, sync ข้ามเครื่อง) แยก symbol/bar interval; `drawingOverlay` = REG + trend lines (วาดใหม่ในที่ ไม่ rebuild chart), มี active channel สำหรับปรับ mode, และ regression arming wins the click when event rail could claim it
│   ├── indicators/volume-profile.ts ← session+composite VP (gap-based sessions, delta, naked POC, HVN/LVN, VRVP)
│   ├── point-labels-primitive.ts    ← series primitive วาด text ที่จุด (time, price) — ใช้ผ่าน `IndicatorSeriesOutput.labels` (overlay line เท่านั้น); high วางบน low วางล่าง, clamp ไว้ในกรอบ pane, label ที่ทับกันฝั่งเดียวกันถูกข้าม. ไม่ใช้ `createSeriesMarkers` (ดู event-rail-overlay.ts)
│   ├── indicators/zigzag.ts         ← ZigZag overlay (trend): pivots ≥ Deviation % apart, source High/Low หรือ Close, Live leg On/Off, **Pivot labels** Off / Price / Price + swing % (วาดโดย `point-labels-primitive.ts`), O(N) one pass. Pivot ที่ confirm แล้วไม่ขยับ; ขาสุดท้าย (running extreme) วาดเป็นเส้นประแยก series และ repaint — ส่ง 2 series เสมอ (ว่างได้) เพราะจำนวน output เปลี่ยน = ModularChart rebuild. Tested in `__tests__/zigzag.test.ts`
│   ├── indicators/sd-zones.ts       ← S/D Zones overlay (trend): กล่องสีอ่อน demand เขียว / supply แดง, วาดเป็น canvas overlay (`createSdZonesOverlay`, zOrder bottom) — `compute()` คืน [] ส่วน `useChartIndicators` เพิ่ม overlay เมื่อมี instance id `sdz-*`. 2 โหมด: **pivot** (default — ATR ZigZag, ขาออก ≥ legMove×ATR ภายใน legBars, กล่อง = แท่ง pivot, pivot ใหม่ที่ระดับเดิม merge → `reactions` เข้มขึ้น, หลุดที่ยืนยันแล้ว = flip ฝั่งได้ 2 ครั้ง, reactions ติดไปด้วย) · **base** (Seiden base ≤ baseMax แท่งเล็ก + แท่ง departure ≥ impulse×ATR, DBR/RBR/RBD/DBD). **Break** (ทั้งสองโหมด): ปิดเลย distal ≥ breakBuffer×ATR (0.25) หรือปิดนอก breakBars แท่งติด (2) → สถานะ `pendingSince` (กล่องจาง ×0.5 เส้นประ ป้าย "break?"); กลับมาภายใน reclaimBars (3) = spring/upthrust (ฝั่งเดิม, reactions+1, `springs`); ไม่กลับ = break ที่แท่งยืนยัน (ไม่ย้อน back-date). สี demand/supply ปรับเองได้ (param ชนิด `color` → `<input type="color">` ใน IndicatorPicker), Fill strength ×0.2–4, Shade by reactions/touches · departure size · flat. Instance id คงที่ `sdz` — APPLY แทนที่ ไม่ซ้อน. ใช้เฉพาะแท่งที่ปิดแล้ว ไม่ repaint, O(N). ยังไม่มี backtest. **Traps** (2026-10-08, param `traps` bull (default) / both / off — bull = ที่ supply, bear = กลับด้านที่ demand): **breakout** = ปิดเลย distal แล้วปิดกลับภายใน `trapBars` (3) แท่งนับจากแท่งแรก (หลวมกว่า upthrust: ไม่มี buffer, ปิดแท่งเดียวก็นับ) · **wick** = แท่งเดียว ไส้เลย distal ≥ `trapWick`×ATR (0.25) ปิดกลับ และไส้ ≥ 50% ของ range · **reclaim** = เฉพาะ zone ที่ flip มา ครั้งแรกครั้งเดียว: ปิดกลับเข้าใน zone แล้วปิดหลุด proximal อีกภายใน `trapBars` (GULF.BK 2026-09-21→24). รู้ผลตอนแท่งที่ล้มเหลวปิด (แท่งก่อนหน้าถูกตีขอบย้อนหลัง, ไม่ถอนภายหลัง). Checks ไม่อยู่ในนิยาม นับใน label `BULL TRAP 2/3` / `BULL TRAP·RECLAIM 2/3`: V volume แท่งแรก < ค่าเฉลี่ย 20 แท่งก่อนหน้า (ไม่มี volume = ไม่นับ) · W ไส้ปฏิเสธ ≥ 50% · D แท่งล้มเหลวปิดเลย low ของแท่งแรก; `trapMin` ซ่อน trap ที่ได้น้อยกว่า. แสดงผล = overlay ที่สอง `createSdTrapsOverlay` (zOrder top): label เหนือ high สูงสุด + `barBorders` → **ขอบแท่ง** เป็น `trapColor` (ตัวแท่ง/ไส้ยังเขียว-แดง — ผู้ใช้ขอ: ย้อมทั้งแท่งทำให้อ่าน demand/supply ผิด). สอง overlay ใช้ scan เดียวกัน (`sharedScan`, WeakMap ต่อ array). `trapBars` > `reclaimBars` แทบไม่เพิ่ม breakout เพราะ zone ยืนยัน break (แล้ว flip) ก่อน — context เท่านั้น. Tested in `__tests__/sd-zones.test.ts`
│   ├── indicators/ichimoku.ts       ← Ichimoku Cloud overlay (trend, 2026-10-09): Tenkan 9 / Kijun 26 / Senkou B 52 / Displacement 26 (TradingView: spans +25 แท่ง, Chikou −25), Chikou Show/Hide. เส้นทั้ง 5 เป็น series บนแท่งที่มีจริง; cloud fill (เขียว A≥B / แดง, เปลี่ยนสีตรงจุดตัด) + ส่วนอนาคตของ span = canvas overlay `createIchimokuCloudOverlay` (zOrder bottom, `logicalToCoordinate` แบบ trend-line) ที่ `useChartIndicators` เพิ่มต่อ instance `ichimoku-*`. `drawingFutureRoom` = max(trend 12, shift−1) → ModularChart `fitView` เว้นที่ว่างขวา. autoscale ไม่เห็นส่วนอนาคต. ช่วง 3M daily (~63 แท่ง) Senkou B เริ่มในอนาคตเท่านั้น (ต้อง 52+25 แท่ง). Tested in `__tests__/ichimoku.test.ts`
│   ├── indicators/atr.ts            ← Wilder ATR / ATR% pane with native green/red per-bar line colors; prior ATR% SMA threshold + rising EMA trend filter; configurable settings and explicit gray warmup.
│   ├── indicators/rv-core.ts        ← realized-vol math shared by the 3 RV panes: `calcRealizedVol(bars, period, estimator, periodsPerYear)` (cc/parkinson/gk/rs/yz, returns ANNUALISED %), `inferPeriodsPerYear()` (median bar spacing → 252/52/12 or 252×bars-per-session), `rollingPercentRank()`. Tested in `__tests__/rv-core.test.ts`
│   ├── indicators/realized-vol.ts   ← RV pane: 3 windows at once (5/21/63 default, 0 hides a line), estimator select
│   ├── indicators/rv-rank.ts        ← RV percentile rank pane (RV window 21 vs 252-bar lookback), zone-coloured histogram + 50 midline
│   ├── indicators/rv-ratio.ts       ← RV(fast)/RV(slow) realized term structure pane, 1.0 reference line, expansion/compression thresholds
│   ├── useSdBands.ts               ← data side of the SD heatmap, shared by stock-view + market-view: useQuery on `/api/options/sd-bands` + **self-heal** — when `snapshotCount === 0` it POSTs `/api/options/iv-snapshot` once per symbol (ref-guarded, or a symbol with no options chain retries forever) and invalidates the query. Effects depend on the ACTIVE BOOLEAN, never on the indicator object: writing `preloadedData` replaces it, so depending on it makes the effect retrigger its own cause
│   ├── heatmap-overlay.ts           ← `createHeatmapOverlay(spec)`: HeatmapSpec → CanvasOverlay. 3-zone layout: LEFT GUTTER (`HeatmapRowLabel` = level + odds beside it, opaque, never scrolls, width measured from its own content) · PLOT (cells sized from the gap between COLUMNS not barSpacing, labelled with `cellLabels`) · RIGHT RAIL (fallback only — dropped when the cells can label themselves, since it would just repeat them). Type scales with row height (`fontFor`, 7–14px); text degrades before it can ever overlap. Text degrades by row height BEFORE it can collide (rail dropped <13px, only ±2σ/0 <18px, prob line <22px, title <26px) — a 5-row pane at the 44px default gives 9px rows, under the 9px type. Cells can carry per-row text (`HeatmapColumn.cellLabels` — the SD pane colours by mode value but LABELS with the price at that sigma), and `HeatmapSpec.rail` reserves a fixed right-edge strip (price + odds per row) that survives a 1-column series or a zoomed-out chart, where cells are too narrow for any text. Rows tile the pane by EVEN DIVISION (they are categories, not prices — a price scale would let a row drift off-pane); `rows[0]` = BOTTOM. Column pitch comes from `timeScale().options().barSpacing`, so columns line up with the candles even when the heatmap is sparser than the price series. Tested in `__tests__/heatmap-overlay.test.ts` (stub 2D context)
│   └── indicators/sd-heatmap.ts     ← IV SD Heatmap pane: 5 buckets (−2σ…+2σ) from `σ_mid=(IV_call+IV_put)/2` under BS lognormal. Data comes PRE-COMPUTED from `/api/options/{sym}/sd-bands` via `config.preloadedData` (fear-greed pattern) — compute() only maps payload dates onto bar times (one column per day) and picks the colour scale. Exports `occupancyColor` (freq ÷ its own reference, so tails read hotter than the centre for the same overshoot) + `cheapnessColor` (sign of `P_rv − P_iv`). Tested in `__tests__/sd-heatmap.test.ts`
│
├── ui/
│   ├── CandlestickChart.tsx     ← custom OHLC candlestick chart
│   ├── market-table.tsx / market-row.tsx / market-section.tsx
│   ├── sparkline.tsx / sparkline-cell.tsx
│   ├── ai-market-analysis.tsx
│   └── general-market-analysis.tsx
│
├── terminal/                    ← command language engine (Lexer→Parser→Registry→Executor)
│   ├── types.ts                 ← Token, AstNode, CommandDef, CommandResult, TerminalCtx
│   ├── lexer.ts                 ← tokenize(raw) → Token[]
│   ├── parser.ts                ← parse(raw) → ParseResult (AstNode | error)
│   ├── validator.ts             ← validate arg count + types
│   ├── registry.ts              ← ALL_COMMANDS, CMD_MAP — 9 nav + 7 setting + 3 info + 10 analysis
│   ├── executor.ts              ← executeAst(ast, ctx, signal) AbortController-safe
│   ├── autocomplete.ts          ← getSuggestions(), isCommandInput() exact-first-word match
│   └── index.ts                 ← public re-exports
│
├── core/
│   ├── bloomberg-button.tsx
│   ├── boot-screen.tsx          ← dynamic() loading fallback + watchdog (auto-reload if terminal chunk stalls)
│   ├── confirmation-modal.tsx
│   ├── global-search.tsx        ← search overlay (/ or Ctrl+K) — terminal engine + stock search
│   (pins/usePinActions.ts       ← only pin write path outside WATCHLIST edit/reorder: pin(symbol, {groupId}|{newGroup}) → PUT /api/pins/by-symbol; optimistic + rollback + toast + pinErrorAtom; ensureLoaded(); exports DEFAULT_WATCHLIST_GROUP)
│   (pins/PinGroupPicker.tsx     ← shared popover: ✓ current group, "Move to <name>" when pinned, "+ New group…" inline (Enter = create + pin/move in one call). Used by global-search + stock-view; WATCHLIST AddCardForm uses a <select> with "+ New group…". Only pinned-assets.tsx writes the localStorage pin cache)
│   ├── keyboard-shortcuts.tsx   ← shortcuts help panel
│   ├── tick-flash.tsx           ← <TickFlash/> (mounted once in bloomberg-terminal): MutationObserver on <body>, flashes any all-numeric text green/red on change; sign-aware; skips user-initiated changes (<400ms after click/key) and ×10 jumps (THB↔USD); opt out with `data-noflash`
│   ├── shortcut-indicator.tsx
│   ├── theme-toggle.tsx
│   └── watchlist.tsx
│
├── hooks/
│   ├── useTerminalUI.ts         ← view navigation handlers
│   ├── useMarketData.ts / useMarketDataQuery.ts
│   ├── useIvSmile.ts           ← on-demand single/multi-expiry chains + optional SVI fit, guarded identity and shared controls
│   ├── useDepth.ts             ← status + depth polling (2 s, slower after a refusal, off when nothing can change) + token request/check
│   ├── useStockData.ts
│   ├── useWatchlistSignals.ts   ← batch daily technical scan for the watchlist
│   ├── useRatesCurve.ts         ← /api/rates → UST + JGB curves for the TICK DATA board (`RateRowData`)
│   ├── useFxTicks.ts            ← /api/fx overview for the TICK DATA FX section (`FxPair`)
│   ├── useAiMarketAnalysis.ts
│   └── index.ts
│
├── atoms/
│   ├── index.ts                 ← Jotai atoms (currentViewAtom + all others)
│   ├── chart-windows.ts         ← floating chart windows: `chartWindowsAtom` (atomWithStorage `bloomberg_chart_windows`) + open/close/closeAll/focus/patch/toggleMinimized write atoms. **Layout memory**: `chartWindowLayoutsAtom` (symbol → last x/y/w/h, `bloomberg_chart_window_layouts`, LRU-capped at 40) + `chartWindowSizeAtom` (last shaped size) — `patchChartWindowAtom` writes them on every geometry commit, so a closed-and-reopened symbol lands where it was left and a brand-new symbol inherits the size. Detached windows: `chartWindowNativeBoundsAtom` (symbol → screen left/top/width/height, `bloomberg_chart_window_native`), `rememberNativeBoundsAtom` (write-if-changed, called on a 2s sampler), `dockAllChartWindowsAtom` (clears `detached` on load). Geometry rules re-exported from `chart/window-geometry`
│   └── terminal-ui.ts
│
└── lib/
    ├── theme-config.ts          ← bloombergColors (dark/light)
    ├── marketData.ts            ← static fallback market data
    ├── bb-volume.ts             ← pure readings for the BB volume overlay: `bbVolumeColumns()` (modes vol · spike = `volumeZ`/4 · delta = robust z of CLV×RVOL, est. · rvol · events = `classifyVolumeEvents`), `blockProfiles()` + `periodBlocks()` + `resolveVpPeriod()` (auto: <1h→session, 1h→week, 1D→month, 1W→quarter; calendar blocks, not rolling N — a rolling POC moves every bar; <15 bars = partial). Tests: `npm run test:session`
    ├── volume-stats.ts          ← `volumeZ()` (robust log-volume z-score: median/MAD of ln V) + `volumeRatio()` (baseline `median` | `mean`). Intraday bars are SLOTTED against the same point in prior sessions — by **bar index since the session's first bar** when >1 session is loaded (DST-proof; UTC time-of-day keying empties every slot for a lookback after each DST change), by UTC time-of-day on a single 24h session (crypto). Sessions split on a >4h gap, same constant as vwap.ts. `mode: "cum"` compares the session's volume SO FAR against the same point in prior sessions, which is what makes a live partial bar read honestly instead of "quiet". `MIN_SAMPLES` 8, `MIN_SIGMA` 1e-6 (a repeated-value history leaves σ at ~1e-16 — dividing by it turns one share into z=1e15). Mirrored server-side by `backend/alerts/operands._vol_z_series` for daily bars. Tests: `npm run test:session`
    ├── volume-events.ts         ← `classifyVolumeEvents(bars, cfg)` → `VolumeEvent[]`: volume as countable events rather than a series. Six types, one label per bar, priority `climax > vacuum > breakout > absorption > noDemand` (+ `dryUp`, run-based, emitted at the run's END and only when that bar is otherwise unlabelled). Every rule is a joint threshold on z (participation) × retSigma (result) × range/closePos (who won the bar). `dir` is **never a forecast** — which side owned the bar. `forwardReturnPct(bars, i, h)` is null past the data, deliberately (a 0 there biases every eye that reads the table). `EVENT_CODE` / `EVENT_NAME` / `EVENT_DOC` maps. Tests: `npm run test:session`
    ├── market-utils.ts / currency-utils.ts / time-utils.ts
    └── constants.ts             ← shared constants (ALL_COLS etc.)
```

---

## Key Exports per File

| File | Exports |
|------|---------|
| `atoms/index.ts` | `currentViewAtom`, `searchQueryAtom`, `selectedSymbolAtom`, `watchlistAtom`, all view atoms |
| `atoms/chart-windows.ts` | `chartWindowsAtom`, `openChartWindowAtom`, `closeChartWindowAtom`, `closeAllChartWindowsAtom`, `focusChartWindowAtom`, `patchChartWindowAtom`, `toggleChartWindowMinimizedAtom`, `ChartWindowState`, `MAX_CHART_WINDOWS` (10) |
| `chart/window-geometry.ts` | `clampWindow`, `cascadeOrigin`, `resolveOpenGeometry`, `rememberLayout`, `hasGeometry`, `nextZ`, `canOpenWindow`, size constants |
| `chart/ChartWindowLayer.tsx` | `ChartWindowLayer` |
| `chart/FloatingChartWindow.tsx` | `FloatingChartWindow` |
| `chart/ChartPanel.tsx` | `ChartPanel`, `ChartPanelProps` |
| `chart/CompareChart.tsx` | `CompareChart` — 2–10 symbol history queries via `/api/stock`, common-date percentage normalization, explicit missing-data labels |
| `chart/price-scaling.ts` | `usdPriceSymbol`, `scaleBars` — quote-currency→USD→selected-unit OHLC conversion; skips dates without a usable rate |
| `chart/RegressionControls.tsx` | `RegressionControls` |
| `chart/TrendLineControls.tsx` | `TrendLineControls` |
| `chart/useChartDrawings.ts` | `useChartDrawings` (React Query `["chart-drawings"]`, optimistic `saveDrawing`/`removeDrawings`, one-time localStorage import), `ChartDrawingRow` |
| `chart/indicators/zigzag.ts` | `createZigZag`, `calcZigZag`, `ZigZagPivot`, `ZigZagResult`, `ZIGZAG_SOURCES`, `ZIGZAG_LIVE`, `ZIGZAG_LABELS` |
| `chart/indicators/sd-zones.ts` | `createSdZones`, `createSdZonesOverlay`, `createSdTrapsOverlay`, `calcSdZones`, `scanSdZones`, `calcPivotZones`, `scanPivotZones`, `calcBaseZones`, `scanBaseZones`, `fillAlpha`, `hexToRgb`, `zoneTag`, `trapLabel`, `SdZone`, `SdTrap`, `SdScan`, `BreakRule`, `TrapRule`, `SdZoneKind`, `SdPattern`, `SD_ZONE_PARAMS`, `SD_TRAP_OPTIONS` |
| `chart/indicators/ichimoku.ts` | `createIchimoku`, `createIchimokuCloudOverlay`, `calcIchimoku`, `readIchimokuConfig`, `ICHIMOKU_PARAMS`, `ICHIMOKU_COLORS`, `IchimokuConfig`, `IchimokuResult` |
| `chart/bar-borders.ts` | `outlineBars(bars, overlays)` — สีขอบแท่งเทียนรายแท่งจาก `CanvasOverlay.barBorders?(data)` (bar index → สี); ModularChart เรียกทุกครั้งที่ส่ง bars เข้า candle series. เฉพาะ `borderColor` ไม่แตะ body/wick. `OutlinedBar` |
| `chart/indicators/trend-line.ts` | `createTrendLineOverlay`, `createTrendHitMap`, `hitTestTrendLines`, `sameTrendBar`, `TrendHitMap`, `StoredTrendLine`, `TrendPoint` (`futureBars?`), `TrendPreview`, `TREND_LINE_COLOR` |
| `chart/ModularChart.tsx` (drawing input, 2026-09-28) | `ChartClickContext.futureBars` — a click right of the last bar reports `time` = last bar + N bars. `onPointerMove(ChartHoverPoint\|null) → boolean` (return true = repaint `drawingOverlay`, no React render; guarded against the crosshair event the repaint re-emits). `futureRoomBars` > 0 scrolls that much empty space in (trend tool armed = 12). Hook exports `handlePointerMove`, `drawingFutureRoom` |
| `chart/indicators/regression-channel.ts` | `RegressionSelection`, `RegressionChannelOptions`, `StoredRegressionChannel`, `REGRESSION_COLORS`, `createRegressionChannelOverlay` |
| `chart/bollinger-fit.ts` | `BOLLINGER_PERIOD_GRID`, `BOLLINGER_DEVIATION_GRID`, `BOLLINGER_FIT_MIN_BARS`, `BOLLINGER_FIT_PARAMS`, `calcBollingerStats`, `bollingerPercentB`, `evaluateBollingerBreakout`, `fitBollingerSharpe`, `resolveBollingerParameters`; types `BollingerStats`, `BollingerBacktest`, `BollingerFitCandidate`, `BollingerFitResult` |
| `chart/indicators/atr.ts` | `createATR`, `calcAtrRegime`, `resolveAtrConfig`, `validAtrInputs`, `ATR_REGIME_PARAMS`, `ATR_REGIME_COLORS`; types `AtrRegimeConfig`, `AtrRegimePoint`. Public chart/indicator barrels re-export all except picker-only `validAtrInputs`. |
| `chart/types.ts` (indicator points) | `SeriesDataPoint` accepts optional native line `color`; `WhitespaceDataPoint` supplies an explicit missing time; both are accepted by `IndicatorSeriesOutput.data`. |
| `chart/IndicatorPicker.tsx` (ATR settings) | `INDICATOR → ATR Accumulation → APPLY ATR`; gear reopens raw BARS/DAYS inputs; colored chip and applied diagnostics share the chart calculator. |
| `chart/BollingerFitSummary.tsx` | `BollingerFitSummary({data, costBps, colors})` |
| `chart/IndicatorPicker.tsx` (Bollinger settings) | `data` prop must be the same immutable bars passed to ModularChart. BB/%B default Manual; Parameters → Fit + Apply opts in. Gear reopens raw persisted inputs; chips show effective n/k and Fit / unavailable status. `useChartIndicators.instantiate` stamps **every** instance with transient `config.entryId` + `config.inputParams` (raw DAYS inputs) — the ⚙ editor reads both. |

| `chart/DetachedChartWindow.tsx` | `DetachedChartWindow` |
| `chart/TimeframeRow.tsx` | `TimeframeRow`, `TimeframeControls`, `IntervalPicker`, `TimeframeRowProps` |
| `chart/useAnchoredPanel.ts` | `useAnchoredPanel()` → `{ open, setOpen, toggle, pos, wrapRef, triggerRef }` |
| `chart/useChartTimeframe.ts` | `useChartTimeframe()`, plus pure `applyPeriod(p, interval, chartType)` / `applyInterval(iv, period)` for components that store the timeframe outside React state |
| `chart/useAutoExtendRange.ts` | `useAutoExtendRange({symbol, period, interval, barCount, isLoading, enabled})` → `{ effectivePeriod, onLogicalRange, atMaxHistory, extended, viewportKey }` — ซูมออกสุดข้อมูล → ไต่ period ladder โหลดประวัติเพิ่มเอง; plus `periodSpanDays`, `ladderSteps` |
| `chartkit/prefetch.ts` | `isApproachingEdge`, `planPrefetch` — warm history window ถัดไปล่วงหน้า (เทคนิค stream LOD); คู่กับ `usePrefetchStockHistory()` ใน `hooks/useStockData.ts` |
| `chartkit/` (lib ของเราเอง) | `buildLadder`, `nextWider`, `needsExtend`, `planExtend`, types `LogicalRange`/`TimeRange`/`ViewportSample`; `chartkit/adapters/lightweight-charts` → `watchLogicalRange`, `captureVisibleRange`, `applyVisibleRange`. **กฎ:** core บริสุทธิ์ (ห้าม import engine/React), engine อยู่ใน `adapters/` เท่านั้น — ดู `chartkit/README.md` |
| `chart/ModularChart.tsx` (perf contract) | props `indicators`/`overlays` = **โครงสร้าง** (ต้อง memo ที่ call site); `eventMarkers` เปลี่ยนแล้ว update rail primitive ใน chart เดิม; `viewportKey` เปลี่ยนแล้วรอ data ใหม่ก่อน `fitContent()`. `data` reference ใหม่จะเรียก refill ทุก series/overlay — `market-view.tsx` จึง memo `rawChartData` จาก `historyQuery.data.quotes`. วัดความสูงก่อน build เพื่อเลี่ยงสร้าง chart สองรอบ. Optional `referencePriceLine` อัปเดตใน series เดิม |
| `chart/ModularChart.tsx` (price units) | Optional `pricePrecision` lets MKT display sub-dollar ratios such as BTC units without rounding the axis to 0.00. |
| `core/market-session.tsx` | `extendedHoursPriceLine(quote)` คืนราคาและสีสำหรับ `PRE`/`POST` ที่มีราคา valid เท่านั้น; MKT, stock-view และ `ChartPanel` (floating/detached) ส่งเข้า `ModularChart`. `PREPRE`/`POSTPOST`/`CLOSED` ไม่วาดเส้น; backend ล้างราคา extended-hours ที่ timestamp เก่า |
| `chart/useWindowDrag.ts` | `useWindowDrag()` → `{ x, y, w, h, isGesturing, isResizing, beginDrag, beginResize }` |
| `views/iv-smile-panel.tsx` | `IvSmilePanel`, `IvSmilePanelProps` — compact/expanded K vs IV%, Raw SVI/points/RMSE, multiple tenors; text-only selectors with the shared native popup palette from `styles/globals.css` and thin dark scrollbar; observed 25Δ skew/curvature below chart; optional stacked Call/Put OI with separate contracts axis and selected-expiry control |
| `hooks/useIvSmile.ts` | `useIvSmile(symbol, enabled)` — discovery + single/multiple expiry + optional fit queries; shared OI on/off and symbol-scoped expiry selection without new requests; guarded identity and refresh |
| `views/depth-panel.tsx` | `DepthPanel`, `DepthPanelProps` — compact/expanded ladder CNT·QTY·BID \| ASK·QTY·CNT with size bars, spread/bp, bid-ask lean, `L1 ONLY` / `L2 ×n`; LEVELS 5/10/20/50 + OVN toggles (`aria-pressed`) (2026-10-08) |
| `hooks/useDepth.ts` | `useDepth(symbol, enabled)`, `DepthError` (`code`), `WebullStatus` — requests only while DEPTH is open. Once a request has answered with a book it opens `EventSource(/api/webull/depth/stream)` and writes each pushed book into the query cache (`live` = pushed, panel tag `● LIVE` / `○ 2s`); the request then drops to a 20 s check. Stream closes with the panel, a refusal, or a hidden tab |
| `lib/depth-book.ts` | `buildLadder(book, maxRows)`, `isDepthSymbol`, `DEPTH_CHOICES`, types `DepthBook` / `DepthLevel` / `DepthLadder` — pure, `lib/__tests__/depth-book.test.ts` (in `npm run test:session`) |
| `lib/trade-tape.ts` | `mergeTape(held, incoming, max)` (the request and the stream overlap; equal prints kept as many times as a feed holds them), `tapeTotals`, `Trade`, `TAPE_ROWS` — pure, `lib/__tests__/trade-tape.test.ts`. `useDepth` returns `trades` + `totals`; `DepthPanel` draws TIME & SALES under the quote / ladder, coloured by side, with B · S · Δ over the prints held (2026-10-08) |
| `lib/volume-by-price.ts` | `addPull(profile, trades, full)` (overlapping pulls counted once; a full pull that does not reach the previous one = `gaps`), `profileRows(profile, maxRows)` (round bucket step, POC, 70% value area), `emptyProfile`, `bucketStep`, types `VolumeProfile` / `ProfileRow` — pure, `lib/__tests__/volume-by-price.test.ts`. `useDepth` returns `profile` + `profileLevels`; `DepthPanel` draws VOL BY PRICE beside the tape: since the panel was opened on the symbol, every print whatever its side, `GAP ×n` when trading was missed (2026-10-08). The tape / profile divider drags (`SplitRow` in `depth-panel.tsx`; share 0.15–0.85 in `useDepth().split`, `localStorage["bloomberg_depth_split"]`, double-click = reset, ← → when focused; `SPLIT` + `clampSplit` in `lib/depth-book.ts`) — the share lives in the hook so the compact and the expanded panel agree |
| `alerts/webull-alert.ts` | `isWebullEvent`, `isWebullEnded`, `webullHeadline`, `webullWhen` ("in 2d 4h", worded from the date when read), `describeWebull` — WEBULL notices (`webull:<KIND>`) on the ticker chip, the alert list and the toast; test `lib/__tests__/webull-alert.test.ts`. `AlertTarget` has `{kind: "depth"}` → `useOpenDepth()` (`alerts/useOpenAlertTarget.ts`) sets `structureModeRequestAtom` + the MKT view; `SectorRegimeHeatmap` consumes the request after its stored view is restored (2026-10-08) |
| `lib/iv-smile.ts` | `buildIvSmile`, `buildIvSmileOi`, `chooseSmileExpiry`, `expiryDays`, `smileTenorDate`, `selectSmileTenors`, `smileSamples`, `sviIvAtStrike`, `smilePlotRows`, `smileWingMetrics`, `SMILE_TENOR_MONTHS`; types `IvSmileOption`, `IvSmileChain`, `IvSmilePoint`, `IvSmileOiPoint`, `SmileSide`, `SmileFitMode`, `SviSample`, `RawSviParameters`, `RawSviFit`, `SviFitResponse`, `SmileTenor` |
| `lib/quote-stream-client.ts` | `createQuoteStreamClient({EventSource, fetch, sessionId, …})` → `{listen, subscribe, cadence, dispose, state}` — the page's one SSE session: union of listeners, diff via `POST /api/stream/interest`, reopen only on none/closed/404, `ready.resumed` → resend, stale-POST guard (stream generation). Pure; tests `lib/__tests__/quote-stream-client.test.ts`. `useQuoteStream` / `useStreamPollInterval` are thin wrappers over a lazy singleton |
| `hooks/useChangeFeed.ts` | `useChangeFeed()` (mounted once in `layout/bloomberg-terminal.tsx`) — invalidates `CHANGE_KEYS[table]` when the heartbeat's `changes[table]` moves; `chart_drawings → ["chart-drawings"]` (that query no longer polls) |
| `lib/market-data-client.ts` `fetchQuote` | queryFn of `quoteQueryOptions`: full quote when fundamentals are older than `QUOTE_FUNDAMENTALS_MS` (30 min), else `quoteLiteBatcher` (`?fields=price`) merged over the last full one |
| `hooks/useHeartbeat.ts` | `useHeartbeat(select?, pollMs=15s)` — one shared `["heartbeat"]` query over `/api/heartbeat`; `HEARTBEAT_KEY`, type `Heartbeat`. `useSync` / `useProviders` / `BackendStatusBanner` select their part (was 3 separate polls) |
| `lib/stream-cadence.ts` | pure: `streamCadence` → `"streamed"`/`"quiet"`/null, `pollInterval(base, cadence)`, `openSymbolsOf(rows)`, `isOpenMarketState`, `symbolKey`; constants `STREAM_TICK_FRESH_MS` 120s, `STREAM_BACKOFF_MS` 300s, `QUIET_BACKOFF_MS` 120s. Tests `lib/__tests__/stream-cadence.test.ts` |
| `hooks/useQuoteStream.ts` | `useStreamPollInterval(openSymbols \| null, base)` (2026-09-28) — REST cadence that backs off to 5 min while every open symbol ticks on a connected stream, 2 min when nothing is open, else `base`; `null` = no data yet → `base`. Used by market-data, volatility, FX, watchlist quotes, stock header. |
| `hooks/useQuoteStream.ts` | `useQuoteStream(symbols, onTicks, active?)` — ONE shared EventSource per page for the union of all listeners' symbols (browser caps 6 conns/origin), reopen coalesced 250ms; batches ≤1/s; only while real-time ON + tab visible; type `QuoteTick`. Used by PORT positions, `useStockHistory`, `useStockQuote` |
| `lib/tick-grammar.ts` | `TICK_TABLE` / `TICK_HEAD` / `TICK_REGION` / `TICK_SUBGROUP` / `TICK_NOTE` — type sizes shared by TICK DATA board, watchlist compact rows, FREQ/ACTIVE (rows 10.5px/15px since 2026-09-26); change sizes here only |
| `lib/number-format.ts` | `fmtPriceStd` — house price format: min 2dp, never whole-number rounding; <1 → up to 4dp (CLAUDE.md "Number format") |
| `lib/live-quotes.ts` | `patchQuote` (stock quote cache), `patchRow`/`patchRowGroups` (TICK DATA rows: indices, volatility; YTD rebased), `patchFxPairs` — LAST+CHG from one tick, same object when unchanged |
| `chart/rolling.ts` | Window statistics every indicator must use (rules: `chart/indicators/index.ts` header, test `indicator-rules.test.ts`): `rollingMean`, `rollingVariance(values, k, ddof)` (sliding Welford, resync every k), `rollingMax`/`rollingMin` (monotone deque), `SortedWindow` (`median`, `countBelow`, `at`, `madAbout` — O(log k), bit-identical to sort), `RollingSample` (last N slots with empty ones: sorted view + running sums + chrono `forEach`). Tests: `__tests__/rolling.test.ts` |
| `chart/useChartTimeframe.ts` | `applyInterval(iv, period, preferred?)` — `preferred` = last hand-picked period, restored once the interval allows it (1D→1W→1D returns to 3M, not MAX); `useChartTimeframe` and `ChartPanel` track it in a ref |
| `chartkit/live-bars.ts` | `applyTickToBars(history, tick)` — tick → last candle close/high/low, or a new bar when past it (intraday on the last bar's grid; daily by exchange-local date; weekly/monthly update only). Needs `utc_offset_min` |
| `views/portfolio/live-patch.ts` | `applyTicks(payload, ticks, base)` — moves open-positions payload by (tick − cached price) × volume (keeps backend entry-FX cost); same object back when nothing changed |
| `hooks/useTerminalUI.ts` | `useTerminalUI()` → `{ currentView, handleKeyPress, ... }` |
| `layout/bloomberg-terminal.tsx` | `BloombergTerminal` (default) |
| `layout/tail-risk-ribbon.tsx` | `TailRiskRibbon` — content-width risk level + 3 named events ranked by severity/score; LIVE starts immediately after it; click opens TAIL |
| `layout/alert-ticker.tsx` | `AlertTicker` — fixed alert summary + moving quote feed in the same 24px row |
| `layout/terminal-header.tsx` | `TerminalHeader` |
| `ask/index.ts` | **The only ASK code.** `AskDock` (mounted once in `layout/bloomberg-terminal.tsx`, `next/dynamic`; the drawer over every view that has no column of its own — a new view gets ASK with no code), `AskBar` + `AskColumn` (a view that wants the conversation as a column: bar above the content, column last in the flex row; mounting `AskColumn` registers the view as host and the drawer stays away), `useAskColumnShown()` (view makes room), `useAskContext({symbols, note})` (page tells the model what is on screen; the view name is sent automatically), atoms `toggleAskAtom` (header icon / `c`), `askDrawerShownAtom`, `askOpenAtom`, `askBusyAtom`. No prop drilling: surfaces read theme and state themselves (2026-10-06) |
| `ask/images.ts` | Pictures for a question: `toAskImage(file)` (canvas → JPEG data URL, long side ≤1568 px), `imageFiles(dataTransfer)`, `MAX_ASK_IMAGES` = 4 (same as backend `_MAX_IMAGES`). Tray = `askDraftImagesAtom`; `useAskAttach()` in `ask-panel.tsx` gives paste (`onPaste` on both question boxes), drop (whole column / bar) and the `ImagePlus` button; sent pictures show under the `Q ▸` line (2026-10-06) |
| `ask/math.ts` | LaTeX in an answer, pure: `splitMath(text)` (inline `$…$` / `\(…\)`, display `$$…$$` / `\[…\]`; a `$` pair is math only with one of `\ _ ^ = {` inside or a lone letter, so dollar amounts stay text), `displayMathAt(lines, i)` (formula on its own lines; null while the closing fence is still streaming). Drawn by `Tex` in `ask-answer.tsx` with **KaTeX** (`katex` dep + `katex/dist/katex.min.css`, HTML cached per formula); also in headings and the `Q ▸` line (`MathText`). Tests: `node --test components/bloomberg/ask/__tests__/math.test.ts`. The prompt (`_SYSTEM`) asks for `$` / `$$` (2026-10-06) |
| `ask/screen.ts` | `readScreen()` — the open view as text for the model's `read_screen` tool: walks the element marked `data-ask-screen` (the view area in `layout/bloomberg-terminal.tsx`), skips `data-ask-surface` (ASK's own bar / column), canvas, svg, hidden nodes and password fields; children of a flex row / table row / grid are joined with ` | `, everything else stacks; `aria-selected` / `aria-pressed` items get `▶`; select / input values in `[ ]`; cut at 24,000 chars. Called by `useAskConversation` when a question is sent — no code in any view. What is switched on is known only from `aria-pressed` / `aria-selected`: every tab, range, mode and show/hide button in `components/bloomberg` got `aria-pressed` on 2026-10-06 (146 buttons, 66 files; shared ones: `CompactTabBtn`, the `TabBtn`s of the stock tabs, PORT's tab strip, `Seg`). TAIL has no toggles. A new toggle needs the attribute too |
| `ask/history.ts` | Pure: `historyFor(messages)` — what goes back to the model: finished question + answer pairs only (a stopped / failed / empty answer is dropped **with its question**, so the roles always alternate), a note in place of earlier pictures, answers cut at 12,000 chars; `historyIsPrivate(messages)`. Tests in `ask/__tests__/history.test.ts` |
| `ask/sessions.ts` + `ask/ask-history.tsx` | Saved conversations: `newSessionId()` (`YYYYMMDD-HHMMSS-xxxxxx`), `archiveSession()` (PUT after each answer, from `useAskPersistence`; skipped when `sessionSignature` has not moved), `fetchSessions()`, `fetchSession()`, `removeSession()`, `setSessionStore()`. `AskHistory` = the HISTORY ▸ panel in the column header and the NEWS bar: STORAGE (GOOGLE DRIVE · THIS MACHINE · OFF · FOLDER — this machine's setting), where it is saved, the list (open · ✕ = move to `_deleted`). Atoms `askSessionIdAtom`, `askHistoryOpenAtom`, `askArchiveNoteAtom`. `conversation.openSaved(id, messages)`; **NEW** (was CLEAR) starts a new conversation and leaves the old one in its file (2026-10-06) `pinSession()` (PATCH), pure `groupSessions()` (PINNED · TODAY · YESTERDAY · LAST 7/30 DAYS · EARLIER) and `matchesFilter()`. `AskHistory mode="drop"` = dropdown under the AskBar; `mode="tab"` = the HISTORY tab of the ASK column (CHAT · HISTORY share `askHistoryOpenAtom`; filter box, ★ pin, STORAGE folded) (2026-10-06). Delete: ✕ on a row → inline DELETE/CANCEL (the open chat too — then `onDeletedCurrent` = `ask.clear`); TRASH view: RESTORE · ERASE (confirm) · EMPTY TRASH (confirm); `fetchTrash` / `restoreSession` / `purgeSession`. `AskRecent` = RECENT CHATS under the starters of an empty chat; `useAskSessions()` = the shared `["ask-sessions"]` query. |
| `ask/persist.ts` | The working copy of the conversation this tab is in: `sessionStorage["bloomberg_ask_conversation"]` = `{v: 2, id, messages}` (closing the tab ends it; the record is the file, above). An empty conversation never erases it — only NEW does. `restore(raw)` / `forStorage(messages, pictures)` pure, `loadConversation()` / `saveConversation()`; an answer cut by the reload comes back marked. `useAskPersistence()` (in `useAskConversation.ts`) is mounted once by `AskDock`: saves when a question starts, when it ends and on CLEAR. Over the quota the pictures are dropped and counted (`lostImages`). Each question carries `at` and shows its time |
| `ask/history.ts` (2) | `PICTURE_MEMORY` = 3: the latest question with pictures has them sent again (`AskTurn.images`) for 3 exchanges; older ones are only mentioned. `conversation.again()` + COPY / ASK AGAIN under an answer (`ask-panel.tsx` `Answer`; ASK AGAIN on the last one only, it replaces that exchange) |
| `proxy.ts` (repo root) + `lib/request-origin.ts` | Next 16 middleware: every non-GET request to `/api/**` must come from the app's own page (`crossOriginReason`). One place for ~60 write routes |
| `lib/ask-proxy.ts` | Pure helpers of the ASK proxy routes: `crossSiteReason(headers, allowed)` (same-site guard for the POST routes), `allowedHosts(env)`, `backendError(raw, status)`. Tests in `lib/__tests__/ask-proxy.test.ts`. **`npm run test:ask`** runs these + the ask tests (21) |
| `ask/store.ts` | All ASK state as atoms (incl. `askDraftTextAtom`: the unsent text survives hide / show, the bar ↔ column move and a view change): messages (not persisted), busy, model choice (`atomWithStorage` `bloomberg_news_ask_model`), settings open, focus signal, host count, separate open flags for column and drawer, page context. `ASK_API` = the one proxy path |
| `ask/useAskConversation.ts` | `useAskConversation()` → `{messages, busy, ask, stop, clear}` — reads watchlist, model choice, current view and page context itself at send time; streamed events applied once per 50 ms. `useAskStatus(choice)`, `useAskModels()`, `useSaveAskKey()` |
| `core/tick-flash.tsx` | `TickFlash` |
| `layout/mobile-nav.tsx` | `MobileNav` |
| `portfolio/index.tsx` | `PortfolioView` (default) |
| `portfolio/types.ts` | `Trade`, `Account`, `CashEntry`, `CashAdjustment`, `Dividend`, `Summary`, `ThesisData`, `OptionPosition` |
| `portfolio/helpers.ts` | `fmt`, `fmtAmt` (exact money, 2dp — no K/M), `fmtPx` (trade price 2–4dp), `fmtQty` (volume/qty ≤7dp), `fmtAxis` (K/M, chart axis ticks only), `fmtPct`, `pnlColor`, `wlColor`, `groupKey`, `FLAG`, `Colors` |
| `portfolio/constants.ts` | `ALL_COLS`, `DEFAULT_COLS`, `DENSE_COLS`, `TH_SECTORS` (34), `US_SECTORS` (11), `GROUP_COLORS`, `FINANSIA_SUBS`, `ALLOC_COLORS`, `SECTOR_COLORS`, `BLANK_CASH`, `BLANK_DIV`, `BLANK_FORM`, `STRATEGIES` |
| `portfolio/ui/AccBadge.tsx` | `AccBadge`, `WLBadge` |
| `portfolio/ui/SummaryBar.tsx` | `SummaryBar` |
| `views/bonds/index.tsx` | `BondView` (default) — BOND [B] 2026-09-25 |
| `views/bonds/charts.tsx` | `HistoryChart` (toggleable lines, right axis), `IssuanceChart` (weekly deals stacked + 10Y/IG OAS line), `TreasurySupplyChart`, `SlowCard`, `RANGES`, `RangeKey` |
| `views/bonds/conditions.tsx` | `ConditionsTab` — reads `useCreditData(isActive)` (`/api/crisis`); TED excluded (dead series) |
| `hooks/useCreditData.ts` | `useCreditData(isActive)` — always fetches once (status-bar level), polls 5 min only while CONDITIONS open; `useCreditRefresh()`; types `CreditData` `CreditSignal` `CrisisLevel` |
| `views/bonds/decomposition.tsx` | `DecompositionPanel` — 10Y = expected real + BE + TP (ACM), 20D driver, attribution 1/5/20/60D, tripwires, 20Y context, stacked chart (2026-09-26) |
| `views/bonds/tables.tsx` | `KpiStrip`, `EventStudyPanel`, `DealsPanel`, `AuctionsTable` |
| `views/bonds/types.ts` | `BondOverview`, `BondKpi`, `BondSupply`, `Auction`, `SlowSeries`, `BondIssuance`, `IssuanceDay`, `IssuanceWeek`, `Deal`, `EventStudy`, `EventRow`, `BondDecomposition`, `DecompAttribution`, `DecompWire`, `DecompContext`, `DecompHistoryRow`, `DecompPiece` |
| `views/tail-risk-view.tsx` | `TailRiskView`, `SectionRule` (2026-09-23 — TAIL แบ่ง 4 หัวข้อ: RISK DIMENSIONS · EVIDENCE · MACRO & ROTATION CONTEXT · METHOD; คอลัมน์ซ้าย 208px เหลือแค่ VIX TERM + VOL BOARD, การ์ดที่เหลือย้ายลงกริดเต็มความกว้าง) |
| `views/tail/decomposition.tsx` | `RealRatesPanel` (nominal = real + breakeven per tenor + split line), `EnergySpreadsPanel` (crude/products/cracks, ROLL + EST tags); types `Decomposition` `DecompRow` (2026-09-24) |
| `views/tail/market-events.tsx` | `MarketEventsPanel` (2026-09-24 compact: name · severity · `headline` · ≤4 number chips; click = summary/checked/definition/rule; props `staleHours`, `partial`), `SEVERITY_COLOR`; types `MarketEvent` `EventEvidence` `EventLogEntry` `RiskBasis` `EventSeverity` (2026-09-24 — top section of TAIL; ribbon imports `SEVERITY_COLOR` and prints the top 2 event names after the dimension chips) |
| `views/rotation-table.tsx` | `RotationTable` — MKT REGIME → ROT; TABLE/MAP toggle (`localStorage["bloomberg_rotation_view"]`), US|TH, tail 4/8/12W in MAP (2026-09-24) |
| `views/rotation-map.tsx` | `RotationMap` (SVG RRG: quadrants, faded weekly tails, hover focus, legend-by-quadrant click-to-hide), `RotationMapPanel`, `useRotationMap(market, tail, enabled)`, `RotationMapData`, `QUAD_COLOR` (2026-09-24) |
| `hooks/useCot.ts` | `useCotSnapshot(enabled, window)`, `useCotHistory(key, weeks)`, `cotExtreme()`, `cotKeyFor(symbol)`, `COT_KEY_BY_SYMBOL` (keep in step with backend `cot.SYMBOL_MAP`), `COT_GROUP_LABEL`, `fmtContracts`; types `CotSnapshot` `CotContract` `CotGroupStats` `CotFlag` `CotHistory` `CotGroup` (2026-09-25) |
| `core/cot-chip.tsx` | `CotChip` (▼p/▲p mark on MKT TICK DATA rows with an active flag), `COT_KEY_BY_RATE_ID` (2026-09-25) |
| `views/tail/positioning.tsx` | `PositioningPanel` — TAIL → POSITIONING (context, not counted) (2026-09-25) |
| `views/tail/cycle.tsx` | `CyclePanel` (headline strip · one card per group · a row opens to the rule as worded at the source, track record vs NBER, S&P 500 after past signals · WHAT FOLLOWS: ควรรู้ / ควรทำ / ไม่ควรทำ), `useCycle()`; type `CycleData`. Reads `/api/cycle`; rows are `aria-pressed` buttons (2026-10-07) |
| `views/bonds/positioning.tsx` | `BasisTradePanel` (MARKET), `DealerBalanceSheetPanel` (CONDITIONS), `useCotBasis()` (2026-09-25) |
| ~~`views/cot-factor-panel.tsx`~~ | deleted 2026-10-08 — COT mode removed from the MKT STRUCTURE panel (ex-REGIME) |
| `views/stock/cot/index.tsx` | `CotTab` — stock-view tab `COT`, shown only when `cotKeyFor(symbol)` maps (2026-09-25) |
| `views/portfolio/ui/CotCrowdingPanel.tsx` | `CotCrowdingPanel` — PORT → RISK overview, book vs crowded futures (2026-09-25) |
| `views/portfolio/ui/TradeGuardCard.tsx` | `TradeGuardCard` — PORT → RISK overview top: TRADE GUARD traffic light + book line (today / NAV DD / streak / heat / size ×), action list with HOLD (reason required) / UNDO, collapsible STOPS table and REPORT (R-multiples: followed vs broke, monthly, by strategy, worst) (`/api/v2/portfolio/risk/guard[/override|/report]`, React Query `["risk-guard", accountId, currency]` refetch 5 min, `["risk-guard-report", accountId]` on open) (2026-09-28) |
| `views/portfolio/ui/MarginCard.tsx` | `MarginCard({scope, accountId, colors})` — MARGIN · REG T: level + cushion bar, NLV/ELV/MM/IM/EL/AF/loan/leverage/drop→call, per-underlying colour table, per-position requirement, SETTINGS (enable, rates, thresholds, overrides). `accountId="all"` → one row per enabled account. In PORT → RISK overview (top) and PAPER → DASHBOARD (2026-09-29) |
| `views/portfolio/ui/margin.ts` | `useMarginStatus`, `useMarginOverview`, `useMarginAssetLevels` (→ `account|UNDERLYING` map, drives the auto `MGN` column in POSITIONS), `saveMarginSettings`, `LEVEL_COLOR`, `LEVEL_TEXT`, types `MarginStatus`/`MarginLevel`/… — query key `["margin", …]` (2026-09-29) |
| `views/portfolio/tabs/ImportTab.tsx` (2026-10-01 layout) | ENTRY manual form = numbered `Section`s (1 หุ้นและบัญชี · 2 ราคาและจำนวน · 3 ความเสี่ยงและขนาด · 4 เหตุผล), labelled with `Field`, optional fields toggled per section by `AddToggles` (replaced the global `ExtraFieldToggles` row); SECTOR always visible. `sectorListFor(accountId)` — autoFillSector reads the list of the account the slip switched TO (render-time list was the previous account's → SET code on a US stock). Slip symbols resolve with `fromSlip`: among several listings the exact ticker is taken. |
| `views/portfolio/ui/GuardSizePicker.tsx` | `GuardSizePicker` — ENTRY (buy, resolved symbol): S/M/L buttons fill VOLUME from `/risk/guard/size`, each showing risk % NAV; **RISK row (2026-10-01):** type one number `เสียได้ ฿` (persisted `localStorage["bloomberg_risk_budget"]`) → one answer sized to the form's STOP LOSS (`formStop` → `risk_stop`; else 2×ATR) and `onAutoVolume` fills VOLUME (ImportTab `autoVolume` ref — a typed/slip volume is never overwritten); `▾ ระยะ stop อื่น` opens the ladder table + `ลงเงิน ฿` (implied stop); `onAutoStop` fills STOP LOSS with the guard's auto stop (and follows price changes while the field still holds the auto value). Rendered in `tabs/ImportTab.tsx`, where STOP LOSS is always shown and **required** for a stock buy (not DRIP) and must be below PRICE ENTRY; STRATEGY is required too (`Core` added to `STRATEGIES` — Value/Core/Dividend are exempt from the TIME stop) (2026-09-29) |
| `views/portfolio/ui/WhatIfSimPanel.tsx` | `WhatIfSimPanel`, `ErcSignal` — PORT → RISK → OVERVIEW under TRADE GUARD (2026-09-29, replaced STOP SIM sub-tab + `StopSimPanel.tsx`). Left: ACTION table of held positions with tickable suggestions (guard STOP_HIT sell / OVERWEIGHT trim-to-10% ticked by default unless a HOLD was recorded; ERC trim/buy from `metrics.trim_signals` unticked), typed "หลังทำ" qty beats ticks, Δ value, P(stop) for the selected scenario; "ทำตาม stop ต่อ" toggle; horizon 5/20/60D. Right: scenario chips (+1/0/−1/−2 SD, each DO/DON'T median) → one equity + drawdown chart, summary table with ฿ difference. Headline: selected scenario both ways + today's trades (sold/bought/cash after). POST `/api/v2/portfolio/risk/what-if-sim`, debounced 350 ms, React Query `["what-if-sim", body]` keepPreviousData · 2026-10-02: props `rebalance` (RebalTrade[] → `REBAL` picks) + `focus` (bump = tick only REBAL, stops off); ตลาด ±SD / สุ่ม toggle (`market`); headline gap = `diff_value.p50` with p10/p90 + % paths DO better; random mode shows P(ขาดทุน) |
| `views/portfolio/ui/MonteCarloPanel.tsx` | `MonteCarloPanel` — PORT → RISK → MONTE CARLO (2026-10-02). `GET /api/v2/portfolio/risk/monte-carlo`, React Query `["risk-monte-carlo", accountId, currency, horizon, paths, vol, drift]` (`staleTime: 0` — refetches each time the sub-tab opens, the backend cache makes that free when the book is unchanged; keepPreviousData); RERUN refetches with `fresh=true` (new prices/cash/history). Controls (persisted in `localStorage["bloomberg_port_mc"]`): ช่วง 1M/3M/6M/1Y · เส้นทาง 10K/20K/50K · ความผันผวนเริ่มต้น วันนี้/เฉลี่ย 3 ปี · ผลตอบแทนคาด/ปี 0/5/10/20%. Six stat tiles (median, 90% range, P(loss), VaR 95 ± sampling error, CVaR 95, max drawdown) → fan chart (p5–p95, p25–p75, median, 30 sample paths) | outcome histogram (worst 5% in amber) + loss / drawdown probability tables → holdings table sorted by share of the worst-5% loss (+ per-account split in ALL). Amber notes: excluded holdings, back-filled history, too few paths (`se.var95_pct` > 0.3). Uses `Shell` from `WhatIfSimPanel.tsx` (now exported) and its blue/amber pair |
| `views/portfolio/ui/RebalancePanel.tsx` | `RebalancePanel`, `useRebalance` (React Query `["rebalance", accountId]`), types `RebalData` `RebalRow` `RebalRules` `RebalTrade` — PORT → RISK → REBALANCE (2026-10-02): one-sentence rule summary, KPI strip (TRIM count, sell ฿, realised gain ฿, cash %, HOLD, WAIT, WATCH), rows grouped ขายได้เลย / ถือต่อ — ยังไม่ขาย (2026-10-07: "ยังไม่ขาย" on a TRIM row opens a reason + review-days form → `postRiskDecision` REBALANCE HOLD; "เลิกถือต่อ" ends it; a hold past its date shows "ครบวันทบทวน → ตัดสินใจใหม่") / รอเวลา / เล็กกว่า 1 lot / เฝ้าดู (+ collapsible ปกติ), weight bar (target tick, band shaded, post-trim marker), rules editor (NumInput + rebal_to buttons → PUT/DELETE rules), "จำลองแผนนี้ใน WHAT-IF →" |
| `views/portfolio/ui/RiskDetailBlocks.tsx` | The เชิงลึก part of PORT → RISK → สรุป as four blocks, each ONE sentence the screen writes + ONE picture (2026-10-07; replaced the 7px VaR table, the unlabelled RISK CONTRIB / ERC PARITY bars and the folded `CorrelationSection`): `WhoCarriesRiskBlock` (per holding: money-weight dot → risk-share dot, equal-risk tick), `LossLadderBlock` (VaR → CVaR with its 90% CI → stressed CVaR as bars on one scale, CF / MC as thin comparison rows, horizon 1 วัน–3 เดือน ×√t), `ModelTrustBlock` (each day's return vs that day's VaR line from `var_backtest_series`, crossed days red; `VarValidationCard embedded` = the live log inside it), `CoMoveBlock` (≤ 6 names: every pair as a diverging bar; more: matrix ordered so co-moving names sit together + top / bottom pairs). Types `RiskAsset` `LossMetrics` `BacktestDay`. Colour: blue = money / neutral, amber = risk / loss, red only for a crossed line; text never wears a series colour. Nothing is computed there but the sentences |
| `views/portfolio/ui/RiskBalanceBlock.tsx` | `RiskBalanceBlock` — full-width block under the four เชิงลึก blocks: "ทำให้ความเสี่ยงสมดุล · ต้องซื้อขายอะไร เท่าไร" (2026-10-07, replaces the unlabelled ERC PARITY bars). Mode ขาย + ซื้อ (เงินเท่าเดิม) / ซื้อเพิ่มอย่างเดียว (เงินใหม่: 25% · 50% · เท่าที่ต้องใช้, or a typed amount via `NumInput`). One sentence on top, then a table whose every column has a header — ต้องทำ, จำนวนหุ้น, เป็นเงิน, สัดส่วนเงิน ตอนนี้ → หลังทำ, ส่วนแบ่งความเสี่ยง ตอนนี้ → หลังทำ — and a risk-share axis drawn once above the rows (hollow = now, filled = after, "สมดุล n%" tick). React Query `["risk-balance", accountId, currency, cash, level, useOwn]` → `/api/v2/portfolio/risk/balance`. **Targets are the user's (2026-10-08):** row "ตั้งเป้าที่" = รายตัว · บัญชี (พอร์ตย่อย, ALL view only) · กลุ่มธุรกิจ · thesis; row "เป้า" = เท่ากัน (100 ÷ n) or กำหนดเอง — typed in the target column (per holding) or in the group table (per account / sector / thesis), saved with `PUT /risk/budget` scope = level (replaces that level's set; parts not on screen are kept), ล้างเป้า clears. Each row's own target is a mark on the shared axis |
| `views/portfolio/ui/BearPathPanel.tsx` | `BearPathStrip` (สรุป page: 5 horizon tiles), `BearPathPanel` (MONTE CARLO · ขาลง page: table per horizon + 42-day fan + วิธีคิด), `useBearPaths` (React Query `["risk-bear-paths", accountId, currency, tilt]`), `useBearTilt` (`localStorage["bloomberg_port_bear"]`, 0.55 / 0.6 / 0.7 / 0.8), type `BearData` — down-tilted paths 3/5/7/21/42 days (2026-10-07) |
| `views/portfolio/ui/DecisionJournalPanel.tsx` | `DecisionJournalPanel`, `useRiskDecisions` (React Query `["risk-decisions", accountId]`), `postRiskDecision`, `endRiskDecision`, `KIND_LABEL`, `DECISION_LABEL`, types `RiskDecision` `DecisionKind` `DecisionType` — PORT → RISK → สรุป: journal of stop / rebalance decisions (filter by kind, + เพิ่มบันทึก for FOLLOW / CHANGE / NOTE, จบ HOLD), 2026-10-07 |
| `alerts/useOpenRisk.ts` | `useOpenRisk()` → `(sub?: RiskSubTabRequest) => void` — jump to PORT → RISK on a given page (sets `riskSubTabRequestAtom` + `portfolioTabRequestAtom` + view). `alerts/guard-alert.ts` `riskTargetOf(event)` (`guard:REBALANCE` → `"rebalance"`, other guard / margin → `"summary"`) + `riskLinkLabel`. Used by the alert toast (action button), the ticker alert chip (a button when its first alert is a guard one) and the WATCHLIST bell list (2026-10-07) |
| `lib/tick-board.ts` | TICK DATA customisation, pure: `TickBoardPrefs`, `TickSectionId`, `DEFAULT_TICK_BOARD` (one section MY LIST = IXG), `loadTickBoard` / `saveTickBoard` (`localStorage["bloomberg_tickdata_custom"]`), `addSection` `renameSection` `removeSection` `addRow` `removeRow` `moveRow` `toggleHiddenRow` `toggleHiddenSection` `visibleRows` `customSymbols` `normalizeSectionOrder` `normalizeTickBoard` `cleanSymbol`. Tests `lib/__tests__/tick-board.test.ts` (in `npm run test:session`), 2026-10-07 |
| `views/portfolio/ui/RiskSummaryCard.tsx` | `RiskSummaryCard` — PORT → RISK → สรุป (2026-10-02): risk score /100 + ต่ำ/ปานกลาง/สูง, four plain-Thai lines from `/risk/metrics` (bad day = ensemble_conservative, vol regime, drawdown, effective N + top risk contributor), "ควรทำอะไร" list (rebalance TRIM/WAIT, VaR breach, fat tail, correlation, score ≥ 60) linking to sub-tabs; `budgetOver` prop adds "N กองใช้ความเสี่ยงเกินงบ" → BUDGET (2026-10-07) |
| `views/portfolio/ui/RiskBudgetPanel.tsx` | `RiskBudgetPanel`, `useRiskBudget` (React Query `["risk-budget", accountId, currency, scope]`), `useBudgetScope` (`localStorage["bloomberg_risk_budget_scope"]`, owned by RiskTab so the tab badge counts the same scope), types `BudgetData` `BudgetRow` `BudgetScope` `BudgetStatus` — PORT → RISK → BUDGET (2026-10-07): scope toggle รายหุ้น / SECTOR / THESIS, KPI strip (book volatility vs cap, over / under counts, budget set / free), table เงิน · ความเสี่ยงที่ใช้ · งบ · bar with budget tick · ส่วนต่าง · สถานะ · ต้องทำ (`ลด ฿…` / `ที่ว่าง ≈ ฿…`), sector/thesis rows expand to their holdings, editor (NumInput per bucket, fill เท่ากัน / ตามน้ำหนักเงิน / ตาม conviction rounded DOWN to 0.1, volatility cap, band, two-click ลบงบทั้งหมด → PUT/DELETE `/risk/budget`) |
| `views/portfolio/ui/FactorExposurePanel.tsx` | `FactorExposurePanel`, types `FactorData` `FactorRow` — PORT → RISK → FACTOR (2026-10-07): lookback 6M / 1Y / 2Y, KPI strip (explained by factors, stock-specific, biggest factor, observations), one row per factor (beta, t, risk share + bar, effect of a one-SD month in % and money, top holdings), rows with abs(t) < 2 dimmed, `ซ้อน` mark when VIF ≥ 5, stock-specific row, collapsible holdings × factors beta heat table. React Query `["risk-factors", accountId, currency, lookback, fresh]`; REFRESH sends `fresh=true` |
| ~~`views/portfolio/ui/StopSimPanel.tsx`~~ (deleted 2026-09-29) | was `StopSimPanel` — RISK sub-tab **STOP SIM**: 4 small multiples (+1/0/−1/−2 SD) of equity p50 + p10–p90 band and median drawdown, FOLLOW STOP (blue) vs HOLD (amber) — palette validated with dataviz `validate_palette` (dark #3b8fd9/#c77700, light #2a7bc4/#b86e00), shared y-domain, hover tooltip; headline at −2 SD in ฿; summary table; stop odds per holding; model inputs (β, resid vol, factor SD). Horizon 5/20/60D (2026-09-29) |
| `views/portfolio/ui/VarValidationCard.tsx` | `VarValidationCard` — RISK OVERVIEW: NAV basis line (cash, net/gross, shorts, options Δ), rolling OOS backtest from `/risk/metrics`, live forecast log from `/risk/var-backtest` (2026-09-29) |
| `layout/guard-ribbon.tsx` | `GuardRibbon` — `GUARD ● RED · 5 STOP · 4 NEAR` in the bottom status row next to TAIL (desktop); click → PORT → RISK via `portfolioTabRequestAtom` (atoms/index.ts, consumed by `PortfolioView`) (2026-09-29) |
| `layout/margin-ribbon.tsx` | `MarginRibbon` — `MGN ● WARNING Dime · cushion 6.8% · call −7.3%` next to GUARD; hidden while no account has margin on; worst PORT account (paper accounts skipped since 2026-10-02); click → PORT RISK |
| `views/tail/sector-rotation.tsx` | `SectorRotationPanel` (TILT + 11 diverging bars + RRG tally + AUM record line), `useSectorRotation(window)` (2026-09-23) |
| `views/tail/macro-context.tsx` | `EventStrip`, `MacroPanel`, `MacroReadPanel` (2026-09-20 — 3 axes + CPI/core CPI/PCE/core PCE cross-check row), `useMacroContext`, `MacroContextData`, `MacroRead`, `MacroAxis`, `KIND_COLOR` |
| `portfolio/tabs/AnalyticsTab.tsx` | `AnalyticsTab` — NAV card has GROWTH / VALUE / INDEX modes (`localStorage["bloomberg_nav_chart_mode_v2"]`): VALUE draws `NavValueChart` (4 labelled series: NAV area + HOLDINGS/CASH lines + dashed COST, legend chips double as show/hide so CASH can own the axis), INDEX draws `NavIndexChart` — the time-weighted curve vs its OWN benchmark picker (2026-10-01: `CURVE_BENCHMARKS` select — BROAD SPY/QQQ/IWM/ACWI/SET · THEME SOXX · SECTOR XL*; sectors the open book holds are marked `● N%` from `openPos` GICS `sector`; `localStorage["bloomberg_nav_curve_benchmark"]`; separate from the CAPM benchmark so switching it does not refetch CAPM; only the chosen index is fetched, GROWTH sends none) from `/api/v2/portfolio/nav-index`, with portfolio/benchmark max drawdown and annualized sample STD beside EXCESS, plus an aligned underwater pane beneath the unchanged equity curve: portfolio drawdown fills blue from zero downward and benchmark drawdown stays a yellow line. Both internal to the file. CAPM card: β HEDGE / HEDGE notional / β REAL / vs IDX / α CAPM / t / R² / N; rf chip เปิดแผงตั้งค่า (override ต่อสกุลใน `localStorage["bloomberg_capm_rf"]`) |
| `portfolio/ui/nav-index-metrics.ts` | `indexRiskMetrics`, `runningDrawdownPct` — maximum peak-to-trough drawdown, annualized sample STD and running drawdown percent for INDEX observations; unavailable/missing benchmark points remain null |
| `portfolio/ui/AllocationBasisCard.tsx` | `AllocationBasisCard`, `AllocRow` — ALLOCATION (OPEN) cost-vs-market card (COST/VALUE/DRIFT modes + rebalance table) |
| `portfolio/ui/PortfolioRotationChart.tsx` | `PortfolioRotationChart`, `RotationGroup`, `RotationMode`, `PortfolioRotationResponse` — stacked weekly open-cost by theme/sector/account, COST/% modes, markers, legend click-to-hide; fixed `THEME_COLOR` per theme (2026-09-24) |
| `portfolio/ui/NavGrowthChart.tsx` | `NavGrowthChart`, `NavGrowthData`, `NavGrowthPoint` — signals-style TWR growth: Growth/Avg-month/Deposits/Withdrawals stats, growth line + least-squares trend, ▲ deposit ▼ withdrawal marks, year × month compounded table; default mode of ANALYTICS NAV card (`localStorage["bloomberg_nav_chart_mode_v2"]` GROWTH/VALUE/INDEX) (2026-09-25) |
| `hooks/useStockEvents.ts` | `useStockEvents(symbol)` — chart event rail markers: dividends/splits, earnings (beat/miss, upcoming `E?`, SET deadline `E≤`), macro `FOMC`/`CPI`/`NFP` from `/api/macro/calendar` (`.BK` = FOMC only; upcoming = next of each kind within 45 days so earnings is not pushed off the pane). Marker type `macro` + fields `deadline/period/windowEnd/macroKind/macroLabel/sep/source` in `chart/types.ts`; icon `flag` (2026-09-25) |
- `views/portfolio/ui/PayoffChart.tsx` — payoff chart (2026-09-10): expiry line solid, T+0 dashed, shaded profit/loss regions, reference lines at spot and each breakeven, plus the headline stats. Exports `PayoffChart`, `PayoffResult`, `PayoffPoint`
- `views/portfolio/ui/usePayoff.ts` — `usePayoff(legs, {debounceMs, spot?})` → `{payoff, loading, spot, error, retry}`; `spot` = user-typed price instead of the live quote. Returns the expiry curve immediately from `localPayoff()` and swaps in the backend's answer (T+0 + POP) after a debounce. ⚠️ Depends on `JSON.stringify(legs)`, NOT the array: callers build it inline, so depending on the array re-ran the effect every render and aborted the request every time
- `views/portfolio/tabs/AuditTab.tsx` — PORT → TOOLS → AUDIT (2026-09-16): every change from `/audit-events`, filter by table + action, follows active account, click row for field-by-field BEFORE/AFTER, LOAD OLDER paging. Exports `AuditTab`
- `views/portfolio/modals/CashReconcileModal.tsx` — cash EDIT (2026-09-16; category 2026-09-25): pick account, see DERIVED / ADJUST / CASH NOW, type broker balance → stores the difference; effective date + required UI reason category (UNKNOWN needs note); history with undo. Opened from SummaryBar CASH chip and CASH tab EDIT. Invalidates `["portfolio","summary"]`. Exports `CashReconcileModal`
- `views/portfolio/modals/PayoffModal.tsx` — payoff for a saved lot, combined across every lot on the same underlying by default (a hedge read alone looks like a pure loss) with a `THIS LOT ONLY` toggle
- `views/portfolio/ui/PayoffCalculator.tsx` — PAYOFF CALCULATOR panel at the top of PORT → OPTIONS (LOTS view), 2026-09-28. Type underlying + legs (BUY/SELL, CALL/PUT, strike, expiry, premium, contracts, mult; `+ LEG` for spreads), optional SPOT override → `PayoffChart` + NET DEBIT/CREDIT. Books nothing. Half-typed legs are skipped, not zeroed. State in `localStorage["bloomberg_payoff_calc"]`, collapse in `…_open`
- `views/portfolio/modals/OptionTradeEditModal.tsx` — correct a mis-entered option trade (2026-09-10): every field plus a required-by-convention `reason`, contract terms locked while the trade is matched, and the trade's audit log inline. Exports `OptionTradeEditModal`
- `views/portfolio/ui/OptionTradeLog.tsx` — OPTIONS tab · TRADES view (2026-09-10): every
  option execution with the 5 greeks + spot/IV captured at that trade. Migrated trades show
  `unknown` / `—` with a banner rather than being back-filled with today's values. Exports
  `OptionTradeLog`, `OptionTrade`
- `views/portfolio/ui/OptionAttributionCard.tsx` — ANALYTICS section `DERIVATIVES · PNL ATTRIBUTION` (2026-09-09): portfolio split across Δ/Γ/Θ/ν/residual, stacked bar per day, per-contract table with spot/IV endpoints and `explained_pct`. Exports `OptionAttributionCard`, `OptionAttribution`
| `portfolio/tabs/theses/index.tsx` | `ThesesTab` (props: `colors`, `accountId`, `initialSymbol`, `onConsumeInitialSymbol`) |
| `portfolio/tabs/theses/types.ts` | `Thesis`, `ThesisStatus`, `ThesisEvent`, `ThesisLink`, `ThesisNote`, `NoteKind`, `NoteStatus`, `NoteImpact`, `STATUSES`, `STATUS_COLOR`, `CATEGORIES`, `HORIZONS`, `STRATEGIES`, `NOTE_KINDS`, `NOTE_STATUSES`, `NOTE_KIND_COLOR`, `NOTE_STATUS_COLOR`, `NOTE_IMPACT_COLOR` |
| `portfolio/tabs/theses/ThesisNavigator.tsx` | `ThesisNavigator` (props: `colors`, `selectedId`, `onSelect`, `allLabel?`, `onNew?`, `footer?`), `NavRail`, `useThesisList` (React Query `["theses","list"]`) |
| `portfolio/tabs/theses/nav-filter.ts` | `NavState`, `NAV_DEFAULT`, `NavCounts`, `filterTheses`, `groupTheses`, `facet`, `kindOf`, `sectorOf`, `tagsOf`, `matchesQuery`, `DEFAULT_KINDS`, `INSTRUMENT_KINDS` |
| `portfolio/tabs/theses/useReads.tsx` | `useReads`, `ReadDot`, `UnreadBar`, `ReadType`, `ReadItem`, `UNREAD_COLOR` |
| `portfolio/tabs/theses/QuickTopic.tsx` | `QuickTopic` (props: `colors`, `onCreated`) |
| `portfolio/tabs/theses/ThesisEditor.tsx` | `ThesisEditor`, `ThesisDraft`, `emptyDraft`, `draftFrom` |
| `portfolio/tabs/theses/ThesisNotes.tsx` | `ThesisNotes`, `NoteDraft`, `emptyNoteDraft` |
| `portfolio/tabs/theses/ThesisTimeline.tsx` | `ThesisTimeline` |
| `portfolio/tabs/research/index.tsx` | `ResearchTab` (props: `colors`, `onOpenThesis`) — TOOLS → RESEARCH, all theses' pages newest first; `research/paging.ts`: `ROW_H`, `pageSizeFor`, `pageCount`, `pageOf`, `pageSlice`, `parseUtc`, `fmtStamp`, `matchesResearch`, `newestFirst` |
| `portfolio/tabs/theses/graphs/GraphsPanel.tsx` | `GraphsPanel` (props: `thesisId`, `colors`, `onCountChange`), `AnalysisGraph` |
| `ui/series-board.tsx` | `SeriesBoard` (props: `group`, `colors`, `days`), `SeriesRow`, `SeriesBoardColors` — generic indicator board: sections, values, Δ%, sparkline, detail chart. Names no specific market |
| `views/news/data-tab.tsx` | `DataTab` — NEWS → DATA: group selector from `/api/v2/series/groups` + `SeriesBoard` |
| `portfolio/tabs/theses/ReadView.tsx` | `ReadView` (props: `thesis`, `notes`, `events`, `colors`) — READ mode: the whole thesis as one scrollable document (body + notes + zettel + analysis pages + history) with a scroll-spy contents rail |
| `portfolio/tabs/theses/markdown.tsx` | `renderMarkdown(text, colors, scale)`, `headingsOf`, `slugifyHeading`, `MdScale` (`"dense"` \| `"read"`) — tables, links, ordered/nested lists, blockquote, code fence, hr |
| `portfolio/tabs/questions/index.tsx` | `QuestionsTab` (props: `colors`, `initialQuestion?`, `onConsumeInitialQuestion?` — the jump from TRACK), `Chip` / `Label` / `Errors` (shared with `tracking/`), `QuestionBadges` (props: `pending`, `watch`), `useQuestionCounts()` — React Query keys `["questions", "counts" \| "tree" \| "detail", …]`; `TabStrip` in `portfolio/index.tsx` takes `badges` |
| `portfolio/tabs/tracking/index.tsx` | `TrackingTab` (props: `colors`, `onOpenQuestion(thesisId, questionId)`), `TrackBadges` (props: `alert`, `setup`), `useTrackCounts()` — React Query keys `["tracking", "counts" \| "list" \| "detail", …]`; a write also invalidates `["questions"]` (a miss opens one) |
| `views/calendar/index.tsx` | `CalendarView` (no props; lazy-loaded by `bloomberg-terminal.tsx`, nav `CAL`, key `6`, command `CAL`) — opens on the day in `calendarRequestAtom`, links out through `useOpenTools()`; React Query key `["calendar", start, end]` (refetch 6 s while company dates are `pending`); a save invalidates `calendar`, `theses`, `questions`, `reads`. localStorage `bloomberg_calendar_filter` / `bloomberg_calendar_view` |
| `views/calendar/month.ts` | pure, tested: `monthGrid`, `gridRange`, `addDays`, `shiftMonth`, `weekdayMon0`, `inMonth`, `byDay`, `CalFilter` / `FILTER_DEFAULT`, `matches`, `matchesScope`, `kindCounts`, `toggleCategory`, `kindLabel`, `cellLabel`, `monthTitle`, `dayTitle`, `CATEGORIES`, `WEEKDAYS`, `MONTHS_TH` |
| `views/calendar/DayPanel.tsx` · `AddEventForm.tsx` · `types.ts` | `DayPanel`, `CAT_COLOR`, `CAT_LABEL`, `OpenThesis`, `OpenQuestion` · `AddEventForm`, `AddDraft` · `CalPayload`, `CalEvent`, `CalThesis`, `CalRef`, `CalQuestion`, `CalSources`, `CalCategory` |
| `alerts/useOpenTools.ts` · `alerts/useOpenAlertTarget.ts` · `alerts/calendar-alert.ts` | `useOpenTools()` → `(req: ToolsRequest) => void` — jump to PORT → TOOLS on a thesis (NOTES at a note) or a question (`toolsRequestAtom` + `portfolioTabRequestAtom` + view; `PortfolioView` consumes it). `useOpenCalendar()` → `(at?: {date?, category?}) => void` — the CAL view on a day (`calendarRequestAtom`). `useOpenCalendarTarget()` takes a `CalendarTarget` (`ToolsRequest \| {sub: "calendar", date?}`) to whichever of the two it names. `AlertTarget`, `alertTargetOf(event)`, `alertLinkLabel`, `useOpenAlertTarget()` — one opener for every alert surface (RISK page or TOOLS place). `isCalendarEvent`, `calendarTargetOf`, `calendarHeadline`, `describeCalendar`, `calendarToasts` (one toast per thesis per batch), `whenText`, `todayIso`, `daysBetween` — pure, tested in `views/calendar/__tests__/calendar-month.test.ts`. The ticker chip is a link for any targeted alert and `+N` opens the list of all of them (2026-10-08) |
| `portfolio/tabs/tracking/forms.tsx` | `MetricForm`, `ExpectForm`, `ReadForm`, `call<T>(url, method, body)` → `{data, errors}`, `API` |
| `portfolio/tabs/tracking/types.ts` | `TState`, `TMetric`, `TDetail`, `TPeriod`, `TExpectation`, `TReading`, `TCountsPayload`, `T_STATUS`, `T_VERDICT`, `T_GAP`, `band`, `fmtVal`, `previewVerdict`, `crossesKill`, `whenText` |
| `portfolio/tabs/theses/anti/AntiPanel.tsx` | `AntiPanel` (props: `thesisId`, `colors`, `onChange?`) — THESES → ANTI-THESIS sub-tab: summary line, claim cards (statement / negation / angle strip / threaded objections with verdict, proposal + รับ / ไม่รับ), inline forms (claim, revise, objection, none-found, verdict, reason); `useAntiCounts()` — React Query keys `["antithesis", "counts" \| "board", thesisId]`; `ANTI_API` |
| `portfolio/tabs/theses/anti/types.ts` | `AClaim`, `AClaimState`, `AObjection`, `AVerdict`, `ASweep`, `ABoard`, `ACounts`, `ACountsPayload`, `A_CLAIM`, `A_OBJ`, `A_RESULT`, `A_ANGLE`, `A_ANGLE_STATE`, `A_SUMMARY`, `A_GAP`, `threaded(objections)` |
| `portfolio/tabs/questions/types.ts` | `QState`, `QNode`, `QTree`, `QDetail`, `QAnswer`, `QSignal`, `QAssumption`, `QCountsPayload`, `stateLabel`, `STATUS_COLOR`, `LEVEL_LABEL` |
| `portfolio/modals/SellModal.tsx` | `SellModal` |
| `portfolio/modals/TradeEditModal.tsx` | `TradeEditModal` |
| `portfolio/tabs/OpenPositionsTab.tsx` | `OpenPositionsTab` (prop `onOpenThesis` → TH / +TH badge jumps to TOOLS → THESES) |
| `portfolio/tabs/RiskTab.tsx` | `RiskTab` |
| `views/market-view.tsx` | `MarketView` (default), `KeyIndicatorsBar` |
| `views/market-view.tsx` (compare/scaling) | COMPARE button before VP edits 2–10 symbols; `compare(...)` and `<unit>_scaling` arrive through Jotai atoms from GlobalSearch. Compare plots normalized percent, scaling transforms OHLC and adds an active-unit reset button. |
| `views/news-view.tsx` | re-export of `views/news/index.tsx` |
| `views/news/index.tsx` | `NewsView` (default). Hosts ASK with `<AskBar />` + `<AskColumn />` and reads only `useAskColumnShown()` — it no longer re-renders per streamed token. Tabs and the Polymarket column are still mounted through `memo` wrappers |
| `views/news/watchlist-tab.tsx` | `WatchlistNewsTab` |
| `views/news/newsfeed-tab.tsx` | `NewsFeedTab` |
| `views/news/social-tab.tsx` | `SocialTab` |
| `views/news/polymarket-column.tsx` | `PolymarketColumn`, `ProbBar` |
| `ask/ask-panel.tsx` | Surfaces (see `ask/index.ts` above). `AskAnswers` (internal) holds `useAsk()` itself, so tokens re-render the column only |
| `ask/ask-settings.tsx` | `AskSettings` — MODEL ▸ panel: provider, model (short list + live `/models` + free text), API key (password field, write-only → `POST /api/news/ask/key`). Opened from `AskBar` and from the answer column header (2026-10-06) |
| `ask/ask-answer.tsx` | `AnswerBody` (answer laid out as lead · `## ` sections · bullets with the source on its own dim line · signed % coloured; set in `.reading`), `parseAnswer(text)` — the shape is the one `_SYSTEM` in `backend/routers/news_ai.py` asks the model for; change both together |
| `views/news/useNewsAsk.ts` | `useNewsAsk(symbols)` → `{messages, busy, ask, stop, clear}` (conversation in a module atom, not persisted; streamed events applied in one state update per 50 ms), `useAskStatus()` |
| `views/news/useWatchlistNews.ts` | `useWatchlistSymbols()`, `useWatchlistNews()` → query + `refresh()` (`fresh=1`) + `isUpdating`. First request `wait=1.5`; while the answer has `pending > 0` it re-asks with `wait=4&settle=1` (≤ 8 times, 200 ms apart) — show progress with `isFetching \|\| isUpdating`, not `isFetching` alone |
| `views/news/useNewsQueries.ts` | `useNewsFeed()` (`swr=1`), `useSocialFeed()`, `usePolymarketSignals()`, `usePolymarketSearch()`, `useFreshFlag()`. Feed and signals re-ask after 2–3 s when the answer says `refreshing` (≤ 3 times) |
| `views/news/prediction-ladder.tsx` | `PredictionLadder` |
| `hooks/useStockPredictions.ts` | `useStockPrediction()`, `useStockPredictionSummaries()`, `probColor()` + prediction types |
| `hooks/useCompanyOutlook.ts` | `useCompanyOutlook()`, `useCompanyXbrl()`, `useCompanyFilings()`, `isUsListing()`, `shortMetric()` |
| `core/company-outlook-panel.tsx` | `CompanyOutlookPanel` (`variant="full"` = stock-view OUTLOOK tab · `"compact"` = NEWS column strip) |
| `app/boot-watchdog.tsx` | `BootWatchdog` — inline `<script>` in the root layout; reloads once after 12s unless `window.__BT_MOUNTED__` is set (runs without the client bundle, which the React-side watchdog cannot) |
| `views/portfolio/queries.ts` | `portfolioQueries` (summary · accounts · openPositions · premarket · costOverrides · thesesSummary — React Query defs, `staleTime` mirrors each backend TTL) + `prewarmPortfolio(queryClient)` |
| `hooks/usePortfolioPrewarm.ts` | `usePortfolioPrewarm()` — 4s after terminal mount, on idle, fills the PORT caches so opening PORT paints from cache instead of a ~10s cold fetch chain |
| `core/boot-screen.tsx` | `BootScreen` — loading fallback for the `dynamic(ssr:false)` terminal import; reloads once after 12s if the chunk never arrives (`sessionStorage["bloomberg_boot_retry_at"]` guards the loop), RETRY button after that |
| `core/us-market-clock.tsx` | `UsMarketClock` — ET clock + session phase strip at the top of the TICK DATA board (presentation only) |
| `views/stock/market-state/index.tsx` | `MarketStateTab` (props `symbol` `colors`) — the REGIME panel, mounted by BOTH `news/watchlist-tab.tsx` (panel toggle beside RATE STRESS) and `stock-view.tsx` (REGIME tab), exactly like `RateStressTab`, so the two entry points cannot drift. Six sub-tabs in reading order: SUMMARY (A) · REGIME (B, price + regime shading) · EVOLUTION (C, scores + d/dt) · PROBABILITY (D, stacked posterior) · STRATEGY (E, decision layer + walk-forward button) · DIAGNOSTICS (feature redundancy + model card). **Interpretation tabs come before the decision tab on purpose** — a reader must be able to reject the recommendation without rejecting the description |
| `views/stock/dcf/index.tsx` | `DcfTab` (props `symbol` `colors`) — one shared component mounted in NEWS beside RATE STRESS and in stock-view. Sub-tabs: OVERVIEW · FORECAST · ASSUMPTIONS · SENSITIVITY · AUDIT; supports AUTO/manual model, Bear/Base/Bull, editable numeric assumptions and source lineage. |
| `views/stock/dcf/types.ts` | `DcfModel`, `DcfScenario`, `DcfForecastRow`, `DcfLineageRow`, `DcfResponse` |
| `views/stock/market-state/regime-runs.ts` | `toRuns()` + `Run` — collapses per-bar labels into contiguous runs for the chart's `<ReferenceArea>` bands (one rect per RUN, not per bar) and makes regime DURATION visible. Kept out of the `.tsx` because node's type stripping cannot load JSX. Tests: `npm run test:views` |
| `views/stock/market-state/SummarySubTab.tsx` | `SummarySubTab`, `fmtProb` (never prints 100% for a posterior — ">99%") |
| `views/stock/market-state/types.ts` | `MarketStateResponse` `ValidationResponse` `StateSlice` `ScoreBlock` `StrategyItem` `RedundancyReport` |
| `lib/volume-stats.ts` | `volumeZ()` `volumeRatio()` `median()` `mean()` `madSigma()` `stdev()` `isIntraday()` + `MIN_SAMPLES` `SESSION_GAP_SEC`; types `VolumeBar` `VolBaseline` (`"median"｜"mean"`) `VolMode` (`"bar"｜"cum"`) `VolStatsOpts` |
| `lib/volume-events.ts` | `classifyVolumeEvents()` `forwardReturnPct()` `EVENT_CODE` `EVENT_NAME` `EVENT_DOC`; types `EventBar` `VolumeEvent` `VolumeEventType` (`climax｜absorption｜vacuum｜breakout｜noDemand｜dryUp`) `VolumeEventConfig` |
| `chart/bb-volume-overlay.ts` | `createBbVolumeOverlay()` `readBbVolumeSettings()` `BB_VOLUME_PARAMS` `BB_VOLUME_PARAM_KEYS`; type `BbVolumeSettings` |
| `lib/bb-volume.ts` | `bbVolumeColumns()` `deltaZ()` `closeLocation()` `blockProfiles()` `periodBlocks()` `resolveVpPeriod()` `medianSpacingSec()` + `BB_VOL_MODES` `VP_PERIODS` `Z_CAP` `RVOL_CAP` `MIN_PROFILE_BARS`; types `BbVolMode` `VpPeriod` `BbVolColumn` `BbVolColumns` `BlockProfile` `ProfileBucket` |
| `chart/volume-event-overlay.ts` | `createVolumeEventOverlay()` `resolveCollisions()` `EVENT_COLOR`; type `PlacedChip` |
| `chart/VolumeEventPanel.tsx` | `VolumeEventPanel` (props `data` `colors` `height`) |
| `chart/indicators/rvol.ts` | `createRVOL` + `RVOL_SCALES` `RVOL_BASELINES` `RVOL_MODES` (select options re-exported through `indicators/index.ts` for the registry) |
| `lib/us-market-session.ts` | `computeSession` `fmtClock` `fmtCountdown` + `NYSE_HOLIDAYS` `NYSE_HALF_DAYS` — pure session maths, no React. **US markets have no lunch break**; the model is pre/regular/after + 13:00 ET half-days. Tests: `npm run test:session` (21) |
| `views/portfolio/weights.ts` | `navBreakdown` `weightPct` `fmtWeight`; types `NavInputs` `NavBreakdown` — pure % of NAV maths (NAV = equity MV + option MV + cash). Tests: `npm run test:views` |
| `views/portfolio/ui/usePortfolioNav.ts` | `usePortfolioNav(accountId, currency)` → `{ breakdown, pct }` (reads openPositions + summary query caches); `equityMarketValue(trade)` |
| `views/tail/macro-context.tsx` | `useMacroContext()` `EventStrip` `MacroPanel` `KIND_COLOR`; types `MacroEvent` `EventKind` `MacroContextData` |
| `hooks/useWatchlistSignals.ts` | `useWatchlistSignals(symbols)` → `{ signals, errors, isLoading, refetch }`; types `WatchlistSignal`, `TrendState`, `RsiState`, `MacdState`, `BreakoutState` |
| `lib/constants.ts` | `PYTHON_API` (base URL) |
| `lib/theme-config.ts` | `bloombergColors`, `darkTheme`, `lightTheme` |

---

**Deleted (no longer in codebase):**
- `rmi-view.tsx` + `rmi-chart.tsx` — removed 2026-05-24
- `volatility-view.tsx` — removed 2026-05-21 (still exists as file but not routed)

---

## Global Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `1`–`5` | Navigate visible views: MKT(1), NEWS(2), BOND(3), PORT(4), TAIL(5) |
| `H` | Heatmap (last market; hidden nav) |
| `P` / `T` / `B` | Aliases for PORT / TAIL / BOND |
| `C` | *(free — was Crypto until 2026-08-01)* |
| `E` | *(free — was FX until 2026-08-01)* |
| `Alt+1`–`Alt+N` | Switch sub-tab within current view (BOND 1-2, PORT 1-8, NEWS 1-2) |
| `/` or `Ctrl+K` | Open global search |
| `c` | ASK drawer (on a view with its own ASK column — NEWS — focus its box) |
| `Esc` / `← ESC` button | Back to market/home |
| `Ctrl+R` | Refresh data |
| `Y` | Toggle %Chg YTD / Daily (non-PORT) or THB/USD (PORT) |
| `Ctrl+Shift+T` | Toggle Area / Candlestick chart |
| `Ctrl+N` | New watchlist |
| `?` (Shift) | Show shortcuts help |
| `i` | Focus the MKT symbol search |

Shortcuts use physical letter/number keys when a Thai keyboard layout is active; IME composition and ordinary typing in input fields are ignored. Header and mobile view tabs are real `/?view=...` links: Ctrl/Meta+click and middle click open a new tab, while plain clicks update the current view and browser history.

---

## Adding a New View

1. Add atom value in `atoms/index.ts`
2. Add handler in `hooks/useTerminalUI.ts`
3. Add view block in `layout/bloomberg-terminal.tsx`
4. Add nav button in `layout/terminal-header.tsx`


---

## HMAP — market heatmap (`views/heatmap-view.tsx`)

Opened by the terminal command `heatmap(MARKET, period?)` (alias `HMAP`; bare = last market) →
`TerminalCtx.openHeatmap` sets `heatmapMarketAtom` / `heatmapMetricAtom` and navigates to view
`"heatmap"`. Period picks the metric: `1d` `52w`(`1y`) `50d` `200d`. Global search now closes on a
`navigate` result from a function call too (it used to only for bare nav words).
- Data `/api/market-heatmap` — compact keys: `s n sec cap px d1 w52 d50 d200 hi rv pe cur ms pre post`.
- Layout: hand-rolled squarified treemap (`squarify`) of absolutely positioned divs, sectors first
  then names; `SIZE CAP | √CAP`. `TileLayer` is `memo` and gets stable `onHover`/`onPick`, so the
  hover line re-renders alone. Metric switch ≈25 ms (dev) with no request.
- Colour: diverging red/slate/green with sqrt easing, clamps 1D ±3 · 52W ±60 · 50D ±12 · 200D ±30;
  HIGH centred at −12%; RVOL slate→orange (1×→3×).
- Sector strip: cap-weighted metric per sector, best→worst; click = zoom, `← ALL` back.
- Don't add `HM` as an alias — bare `HM` must stay the H&M stock lookup.

## MKT — left panel feeds (`views/market-view.tsx` + `views/discover-lists.tsx`)

The WATCHLIST header is a REGIME-style switcher **WATCH · FREQ · ACTIVE**
(`localStorage["bloomberg_mkt_left_feed"]`, restored after mount). WATCH (`PinnedAssets`) stays
mounted but hidden when another feed is shown — remounting re-runs its DB bootstrap.
`FrequentSearchList` (top 30 most-searched, `SYM · LAST · CHG · HITS`, × on hover forgets a symbol,
refetches on the `SEARCH_HIT_EVENT` window event) and `MostActiveList` (top 30, `SYM · LAST · CHG · VOL`, VOL
orange when RVOL ≥ 2, dimmed + "session of <date>" before the open) use the TICK DATA row grammar.
Clicking a row loads it in the MKT chart (`handleWatchlistPick`).
**Extended hours — same line:** while any row in a list has a trading PRE/AH quote
(`extLabelOf(quotes)`), two columns appear after CHG with header `PRE`/`AH` (`ExtHead`, colSpan 2):
ext price · ext %chg (`ExtCells`; rows with no ext quote, e.g. indices, get empty cells). Outside
PRE/AH the table is back to its plain columns. Exported from `discover-lists.tsx`, used by WATCH
LIST, FREQ and ACTIVE. Never a second line per row — the user reads this panel squeezed. Search counting:
`lib/search-stats.ts#recordSearchHit` — fire-and-forget, only for symbols opened from a search box
(clicks on the watchlist / board / these feeds are NOT counted).

## MKT — WATCHLIST view modes (`views/pinned-assets.tsx`)

Header text chip cycles **LIST → TABLE → CARDS**; choice persists in
`localStorage["bloomberg_watchlist_view"]` (restored after mount). **LIST is the default** and
uses the TICK DATA grammar: `CompactWatchRow` (memo) — one 13px line, `SYM · LAST · CHG · VOL · SIG`
(VOL = today's `regularMarketVolume`, K/M/B), headers sort (`handleSort`; default + first click on
VOL/SIG/CHG/LAST = desc; key + dir persisted in `bloomberg_pin_sort_key` / `bloomberg_pin_sort_dir`).
Default sort = VOL desc, applied inside each group section. Name / pin return / targets / comment / stale-session note live in the
row tooltip; buy/sell target hit = tinted row + coloured symbol. With >1 group and filter = ALL,
groups render as foldable sections (`localStorage["bloomberg_watchlist_folded_groups"]`).
Click = open in chart, shift-click = chart window, double-click = edit form, right-click = context
menu, **drag row = reorder** (switches sort to manual, same `handleReorder` as TABLE; dropping on a
row of another group also moves the pin into that group via `patch.groupId`). **Group move by drag
(2026-10-06):** a group header is a drop target (`groupDrop` → `handleMoveToGroup`, group only — order
and sort untouched, rolls back on a failed PATCH); while a row is dragged, empty groups show their header
too and the target header is outlined with `← SYM`. A drop on another group's row under a column sort is
also group-only (no switch to manual); under manual sort it reorders + moves. Rows get `stableOpen`/`stableRemove` (ref-backed) so a quote tick doesn't re-render them all.
Header actions (ADD · GRP · group filter) sit left of the signal summary so a squeezed panel never
clips them; the header wraps instead.

## MKT — TICK DATA board (`views/market-view.tsx`)

The right-hand `tickdata` panel is a cross-asset board with seven sections. Each is
collapsible; collapse state persists in `localStorage["bloomberg_tickdata_sections"]`
(default collapsed: `ratesJP`, `fx`). Drag a section header onto another header to reorder
whole sections (the whole header row is the drag handle — no grip/↑↓ buttons). The order persists in
`localStorage["bloomberg_tickdata_order"]`, independently from collapse state.
Invalid/duplicate stored IDs are ignored and newly added sections append to the saved order.

Default order: **RATES · US → RATES · JP → AMERICAS → EMEA → ASIA PACIFIC → VOLATILITY → FX**.
The US market clock and column headings stay fixed above the reordered sections.

| Section | Source | Row component |
|---------|--------|---------------|
| RATES · US (11 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| RATES · JP (15 tenors) | `useRatesCurve` → `/api/rates` | `RateRow` |
| AMERICAS / EMEA / ASIA PACIFIC | `useMarketDataQuery` → `/api/market-data` | `TickRow` |
| VOLATILITY (VIX family) | `/api/volatility` | `TickRow` + subgroup headers |
| FX (20 pairs) | `useFxTicks` → `/api/fx` | `FxRow` |
| Custom sections (`c:…`, user-made; default MY LIST = IXG) | `/api/tick-custom?symbols=` (React Query `["tick-custom", symbols]`, stream-patched) | `TickRow`, `FxRow` for `…=X`, a notice row for a symbol with no quote |

**Customising the board (2026-10-07)** — the ✎ button in the TICK DATA header (`aria-pressed`) switches to EDIT: prices give way to one row per symbol with its controls. Built-in rows and sections: HIDE / SHOW (struck through while hidden; SHOW ALL HIDDEN at the foot). Own sections: `+ NEW SECTION`, rename in place, ✕ → DELETE? (two clicks), `+ SYMBOL` (typed symbols go through `resolveSymbol`, so CPALL becomes CPALL.BK with label CPALL), ▲ ▼ ✕ per row. Sections move with ▲ ▼ in EDIT and by dragging the header outside it. Logic is `lib/tick-board.ts`; saved per browser (not synced). Hidden rows and custom rows are out of the ▲/▼ tally. MOVE sits in VOLATILITY (COMMOD/RATES) — a built-in row.

**Layout (2026-09-25 minimal redesign):** 4 columns only — `NAME · LAST · CHG · YTD` at 9px /
13px row, no vertical padding. No sparkline column and no absolute-change column: the board is
read squeezed to its 15% minimum, where those pushed YTD off the edge. CHG = %chg for
indices/FX/vol, **bp for yields**; rate YTD is whole bp; rate LAST has no `%`. A stale session
move is only dimmed — its day tag lives in the tooltip. `TickRow`/`RateRow`/`FxRow` are
`memo` and take a stable `onSelect(item)` — never pass an inline `onClick` closure.

Things that will bite:
- **One highlight, one state.** `selectedTickId` lights the row; `selectedLabel` captions the chart.
  They deliberately diverge — clicking a tenor with no `chartSymbol` (7 of 11 UST, all 15 JGB) lights
  the row but must NOT touch `selectedLabel`, or the header reads "US 7Y" over someone else's prices.
- **`upCount`/`downCount` exclude rate rows** — "yield up" means the bond market fell, so mixing them
  into the ▲/▼ tally would count two opposite meanings together. FX rows are included.
- **`fmtQuote(symbol, n)`** decides the unit in the chart panel: `%` for `^IRX/^FVX/^TNX/^TYX`,
  `fmtFxPrice` for `*=X` (5 dp, 3 dp for JPY crosses), `$` otherwise. `/api/stock` serves both
  `EURUSD=X` and `^TNX` directly — verified, no special-casing needed in `useStockHistory`.

## Bollinger Fit — 2026-09-13

- MKT, stock analysis and shared `ChartPanel` (floating/detached windows) all pass chart bars into the picker. Factories and diagnostics share one calculator; enabling BB and %B with equal costs fits identical parameters.
- `period` / `stdDev` remain manual fallbacks. Fit always searches **bars**, regardless of global DAYS/BARS input setting. Mode and cost persist in the existing `chart:indicator-specs` atom; the selected n/k and fitted returns never persist across symbols or datasets.
- Uses all loaded history, not only the visible viewport. Search recomputes when the dataset/cost changes; cash rate and risk-free rate are zero and Sharpe is **per bar**, without an annualization calendar assumption. The last candle is conservatively excluded. Minimum 201 input bars; first 100 are warmup; remaining closed bars split chronologically 70/30. At least 3 completed training trades and finite nonzero return SD qualify a candidate. Ties select smaller n, then k; negative best scores remain negative.
- Manual chart behavior is preserved when fitting is unavailable, with a visible `FIT N/A · MANUAL` chip and reason in settings. Historical fitted bands redraw using the winning parameters, so the display is not a walk-forward signal history.
- `alerts/quickAlerts.ts` omits fitted BB/%B from the active-chart suggestions because the daily alert backend cannot reproduce a chart-local fit. Fixed-parameter alert catalog/custom rules remain available. `quickAlerts.ts` and `customCondition.ts` exclude `fitCostBps` from signal params.


## ATR Accumulation Pane — 2026-09-13

- Optional registry entry `atr-regime` in Volatility. Stable pane ID preserves pane identity when settings change. Available through the shared picker/hook in MKT, stock analysis and chart windows; default indicator specs are unchanged.
- Defaults: Wilder ATR14, prior ATR% baseline50, limit1.0, trend EMA50, slope span5, display `percent`. `ATR% = 100 × ATR / close`. First TR uses high-low; later TR includes gaps from previous close. ATR and EMA use full-window SMA seeds.
- Green (`accumulate`) requires ATR% <= the **previous** lookback ATR% SMA × limit AND close > EMA AND EMA > its value slope-bars ago. Red (`avoid`) means the complete-data rule is false. Gray (`unknown`) covers incomplete history/invalid HLC and zero baseline. With default BARS settings the first possible classification is the 64th valid bar; ATR values exist earlier and draw gray.
- The thin gray threshold line uses ATR% units by default. In absolute display it is converted with current close (`thresholdPercent × close / 100`), so threshold crossings agree with the same normalized classification.
- Window lengths follow the shared BARS/DAYS setting; ratio and display do not scale. `config.inputParams` retains raw spec values for gear edits, while calculator config receives bar counts. Applying changes replaces the existing ATR pane.
- Calculator is O(N), cached by immutable OHLCV array/settings. It uses only current/past bars, so appending future bars preserves existing values. A forming candle can change until close; prepending older history can change recursive seeds. Invalid HLC resets ATR/EMA; explicit `{time}` whitespace retains missing timestamps, while a transparent outgoing segment before each gap prevents the native renderer from joining across it.
- Colors describe the user's configurable low-volatility/uptrend filter, not observed institutional accumulation. This entry has no backend alert outputs or alert labels; it must not be offered as a backend-evaluated operand.


## MKT REGIME IV Smile — 2026-09-13

- **25Δ metrics (2026-09-23):** Below the chart, one row per actual expiry displays observed skew `C25Δ − P25Δ` and curvature/butterfly `(C25Δ + P25Δ)/2 − ATM`, both in IV percentage points. Reuse the same strike range and quote-quality filtered observations regardless of side/FIT display choice; `OBS` marks the source even when Raw SVI is visible. Delta is Black-Scholes spot delta with zero carry (the chain has no reliable forward/dividend yield); interpolate IV between adjacent OTM strikes in delta space, never extrapolate. ATM is the call/put IV mean at spot when quoted, or the OTM put/call interpolation across spot. Missing wings, ATM, spot or positive time show `—`; no synthetic zero.

- **OI overlay (2026-09-13):** OI OFF/ON (defaultOFF), stacked Call cyan/Put amber contracts on right `oi` axis, every IV/SVI line on left `iv` axis. ComposedChart shares numeric K grid; custom centered3px compact/5px expanded rectangles keep OI visible despite dense SVI samples. Tooltip uses contracts for OI and% for IV. One labeled actual expiry is shown at a time, selected among active maturities in MULTI; removed expiry/new symbol safely falls back to first selected expiry. OI totals/P-C reflect selected K range and all contracts regardless of IV/quote filter; unknowns show PARTIAL/unavailable. No extra fetch or refit for OI toggles/expiry selection. Current reported OI only, no daily history. OI can draw when IV has too few points, with explicit insufficient-IV note. Shared compact/expanded hook state, no new persistence.

- `market-view.tsx` passes its main-chart `selectedSymbol` to `SectorRegimeHeatmap`. The lower-left STRUCTURE panel (header read REGIME until 2026-10-08) adds **IV** alongside CORR/GEOM/ROT and also in its expanded modal. It follows main MKT chart selection (watchlist, symbol GO or tick row); floating-window focus does not replace the main chart symbol.
- `views/iv-smile-panel.tsx` keeps numeric `K (strike)` X, `IV (%)` Y and S reference. FIT defaults OFF (observed quotes); Raw SVI is optional. Single-expiry Call cyan/Put amber; multi-expiry color identifies maturity and Put is dashed. Call+Put, Call, Put or OTM selector (OTM uses put below S, call at/above S, never substitutes missing quotes from ITM side). POINTS toggles original observations over fitted lines; unavailable fits keep their observed dots visible. OFF joins actual observations, and missing quotes never become zeros.
- `hooks/useIvSmile.ts` uses existing `/api/options?symbol=&expiry=` only while IV is active. Discovery provides expirations; single default is nearest30 days preferring >=7 DTE. MULTI selects nearest actual expiries to calendar targets 1/3/5/7/9 months, clamps month-end, requires >=7 DTE and max45-day distance, deduplicates shared expiries, labels actual date/DTE with ≈. Month buttons select at least one. Queries reuse `options/chain/symbol/expiry` cache (5min); cancellation and symbol+expiry identity guards prevent stale plots. Per-expiry errors do not remove other available slices.
- **STRUCTURE → DEPTH** (2026-10-08, first mode, before CORR): `views/depth-panel.tsx` + `hooks/useDepth.ts`. Follows the main MKT chart symbol like IV. Default mode stays CORR (DEPTH needs Webull keys). The mode buttons now carry `aria-pressed`.
- Raw SVI fits request `/api/options/smile-fit` only when selected, S>0 and T>0; keys include symbol/expiry/chain dataUpdatedAt/range/quality/side/T. Fits use displayed observations only. `smilePlotRows` makes a shared numeric K grid for aligned tooltips, evaluates each fit only inside its observed strike span and preserves raw dots at exact quoted strikes. Show per-series RMSE (IV percentage points), sample counts via tooltip, and expandable `a,b,rho,m,sigma` or unavailable reason. Positive total variance alone does not guarantee an arbitrage-free surface; UI details say so. Use k=ln(K/S), ACT/365 date-only T because Yahoo does not supply a reliable forward. This is descriptive curve fitting, not a trading signal.
- Expiry/range/quality/fit/points/side/multi/month state is shared across compact and expanded views, without new localStorage keys. Symbol changes reset single expiry to the preferred maturity; other display preferences remain. Range defaults to K±25% (±50% and ALL K available). QUOTED requires positive bid and finite ask>=bid; ALL IV includes unquoted rows. IV<=0.0001/nonfinite stays missing. Chart requires >=3 distinct strikes; SVI requires >=8 per series and log-strike span>=0.05. 0DTE or missing S keeps observed quotes only.
- No options (HTTP404), loading, errors, unexpired-data absence and too few valid points have explicit UI states. Footer displays provider delay (metadata says ~15min) and fetched-at tooltip; this timestamp is not a quote/trade timestamp. Current chain only, no historical strike-level smile.
- CORR/GEOM queries and trend strip are disabled/hidden for IV and ROT. The matrix ResizeObserver reattaches when returning to a matrix view after its DOM was unmounted. Existing hydration-safe mode persistence also accepts `iv`.


## Watchlist shared data and rendering (2026-09-23)

| File | Exports / behavior |
|---|---|
| `lib/market-data-client.ts` | `MarketDataError`, `RequestQueue`, `SymbolBatcher`, `marketJson`, `marketRetry`, `marketRetryDelay`, `retryAfterSeconds`, `StockQuote`, `quoteBatcher`, `sparklineBatcher`, `quoteQueryOptions` |
| `lib/market-data-proxy.ts` | `marketDataProxy` — backend status/body/Retry-After, abort/deadline, no retry |
| `components/bloomberg/hooks/useMarketQueryResults.ts` | `useMarketQueryResults` — public TanStack QueriesObserver, 50ms React notification coalescing, one polling pass per resource, no overlapping passes, pause in hidden tab |
| `components/bloomberg/hooks/useWatchlistData.ts` | `useWatchlistQuotes`, `useWatchlistSparklines` — stable per-symbol query keys, retained cache, complete quote coverage, optional sparkline observers |
| `components/bloomberg/hooks/useStockData.ts` | `useStockQuote` shares quote key/transport with Watchlist; `useStockHistory(symbol, period, interval, enabled)` lets MKT load only the active chart mode |
| `components/bloomberg/hooks/useWatchlistSignals.ts` | per-symbol cache15min + batched network, no list truncation; existing `WatchlistSignal` shape unchanged |
| `components/bloomberg/hooks/useStockPredictions.ts` | all eligible symbols batched10, ready/no-market distinct from error |
| `components/bloomberg/views/pinned-assets.tsx` | full-list price/signal/PM data, sort before paging100 rows, overlapping groups share queries; cards request only displayed sparklines; coverage/errors shown; ADD saves before waiting for price |

The browser transport permits three batch requests concurrently. Quote jobs have priority, with an older non-quote job admitted after three quote jobs. Each reader owns its cancellation; cancelling one reader never aborts a surviving reader's shared request. Query retention30min survives panel remounts. Realtime quotes poll60s (off300s), technical scans900s and PM180s after a pass finishes. Metadata edits do not change quote keys. Data refresh remains full-list even though rendering is paged; groups are optional.

- `core/backend-status-banner.tsx` → `BackendStatusBanner` (2026-09-25) — dev-only (`NODE_ENV==="development"`) strip above the header in `layout/bloomberg-terminal.tsx`: yellow RUNNING OLD CODE + changed files + RESTART BACKEND, red BACKEND DOWN (2 failed polls), blue RESTARTING. Reads the `dev` part of `/api/heartbeat` via `useHeartbeat` (15s, 2s while restarting, refetch on focus; paused while the tab is hidden); renders nothing when current.

- `core/backend-status-banner.tsx` → `BackendStatusBanner` (2026-09-25) — dev-only (`NODE_ENV==="development"`) strip above the header in `layout/bloomberg-terminal.tsx`: yellow RUNNING OLD CODE + changed files + RESTART BACKEND, red BACKEND DOWN (2 failed polls), blue RESTARTING. Polls `/api/dev/status` every 15s (2s while restarting) and on window focus; renders nothing when current.

- `views/portfolio/ledger-filter.ts` (2026-09-25) — pure filter for PORT → CASH ledgers: `LedgerFilter` (range ALL/1M/3M/YTD/1Y/YEAR/CUSTOM, `q` all-words search, account, types[], `minAmount` by |amount|, sort date/amt), `applyFilter(rows, f, RowAccess, today)`, `rangeBounds`, `isFiltered`, `yearsOf`. Undated rows drop out once any date bound is set. Tests: `__tests__/ledger-filter.test.ts` (`npm run test:views`).
- `views/portfolio/ui/LedgerFilterBar.tsx` → `LedgerFilterBar` — the strip above CASH / DIVIDENDS / REINVEST: search, type chips (CASH: DEPOSIT·WITHDRAW·TRANSFER · DIV: THB·USD · REINVEST: FROM DIV·TRADE), range + YEAR + from–to, account (only when tab scope = ALL), ≥ amount, sort cycle, filtered row count + totals, CLEAR. `onUpdate(fn)` is functional so rapid clicks don't overwrite each other. State per sub-tab in `localStorage["bloomberg_cash_filters"]`. CASH's NET CAPITAL column stays the true running balance of the whole ledger, not of the filtered rows.
- `tabs/CashTab.tsx` DIVIDENDS form (2026-09-25): live unit check via `/dividends/check` (500 ms debounce) → line `MARKET … · HELD … → gross …` + issues with one-click fixes; currency follows the asset until the user picks one (`currencyTouched`); save handles 422 with **SAVE ANYWAY** (`force: true`).

- `views/portfolio/ui/EvidenceMatchPanel.tsx` — PORT → TOOLS → AUDIT → **BROKER EVIDENCE** (2026-09-26): per-symbol broker fills vs book, expand for fill ↔ row table + IMAGE link; exports `EvidenceMatchPanel`. Types `EvidenceReport/EvidenceSymbol/EvidenceRow/EvidenceStatus` in `accounting-types.ts`.

## Guard alert modal + terminal toasts — 2026-09-30

- **`alerts/GuardAlertModal.tsx`** (mounted once in `layout/terminal-layout.tsx`) — blocking `alertdialog` for RED TRADE GUARD / MARGIN events: `guard:STOP_HIT`, `guard:DAY_LOSS`, `guard:DD_STOP`, `margin:DANGER`, `margin:LIQUIDATION`. Queue with 1/N counter. **OPEN RISK ↵** = ack + PORT → RISK (SELL/HOLD live there) · **ACK** = ack · **LATER / ESC** = hide for this session only (event stays unacked in the ticker). It never sends an order.
- **`alerts/guard-alert.ts`** — split + presentation: `isModalEvent`, `severityOf` (RED/YELLOW/INFO), `headlineOf`, `nextStepOf`, `fieldsOf` (PRICE/STOP/RETURN · DAY P&L/NAV DD/STREAK · CUSHION/EXCESS LIQ/NLV), `describeGuard`, `guardModalQueueAtom`.
- `hooks/useAlertNotifications.ts` routes: RED guard/margin → modal queue; other guard/margin → toast titled `SYMBOL · HEADLINE` with a labelled description and a severity rule (`--bb-toast-rule`); user alert rules → toast as before.
- **`components/ui/sonner.tsx`** is now `unstyled` + `.bb-toast*` classes in `styles/globals.css` (black surface, 1px border, square, mono, 2px left rule by severity / sonner `data-type`). The old shadcn default followed next-themes with no provider mounted → rendered white rounded cards. Every `toast()` in the app gets the new look.
- **TradeGuardCard layout (2026-09-30)** — light → KPI strip (TODAY · NAV DD · STREAK · HEAT · SIZE · ALERTS, modal-style cells) → one CSS grid `ROW_GRID` (● · CODE · SYMBOL · 3 labelled readings · next step · buttons) grouped ACT NOW / WATCH / HELD. `readingsOf()` picks the three numbers per code (STOP: LAST/STOP/UNDER · OVERWEIGHT: WEIGHT/CAP/TRIM ฿ · …); the long Thai sentence is the row tooltip. HOLD form = reason + REVIEW select + FLOOR `NumInput` (prefilled `hold_floor_default`). Rules footer is a label/value grid. `guard-ribbon.tsx` shows `ALERTS STALE|OFF|ERROR` from `scan`.

## Reading surface — `.reading` (2026-10-02)

PORT → TOOLS (THESES · QUESTIONS · TRACK) sits under `.reading` (`styles/globals.css`): IBM Plex Sans Thai + IBM Plex Mono
(`next/font` in `app/layout.tsx` → `--font-read`, `--font-read-mono`), 13px / 1.6, nothing under 11px. The class remaps the
terminal's small arbitrary sizes (`text-[7px]`…`text-[13px]`) for its descendants, so a panel moved under it is readable
without restating sizes; `.prose-measure` (≤ 74ch, 14.5px / 1.75) is for long-form text. `.font-mono` keeps numbers, refs
and symbols monospace. The rest of the app is still Courier at terminal sizes — do not put `.reading` on a quote board.
